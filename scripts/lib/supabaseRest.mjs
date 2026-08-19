/**
 * Supabase REST(PostgREST)への読み書きをする全スクリプトが共通で使うクライアント。
 *
 * 2026-08-17、トーナメント履歴バックフィル（scripts/backfill-tournaments-from-cache.mjs）を
 * 各スクリプトがその場で書いたfetchラッパーで実行した結果、(1)return=representationを
 * 不要な呼び出しにまで使ってEgressを膨らませた、(2)並列書き込みでWAL/ディスクを使い切って
 * Supabase DB全体を不安定にした、というインシデントが起きた（docs/incident-log.md参照）。
 *
 * 「次から気をつける」は8/15のインシデントで既に「機能しない」と分かっている
 * （docs/incident-log.md 8/15 1件目）。そのときはr2PriceArchive.mjsに実行時カウンタガードを
 * 追加して機械的に防いだ。今回も同じ考え方で、個々のスクリプトの注意力に頼らず、
 * この共通クライアント自体に安全側のデフォルトとガードを組み込む。
 *
 * 組み込んでいるガード:
 * - return=minimalがデフォルト（行データが本当に必要な呼び出しだけ明示的にreturnRows:trueを渡す）
 * - 503（一時的なスキーマキャッシュ再読み込み等）は指数バックオフで自動リトライ
 * - 同一プロセス内での累計レスポンスバイト数を計測し、EGRESS_WARN_BYTESを超えたら
 *   警告を出す。EGRESS_ABORT_BYTESを超えたら例外を投げて強制停止する
 *   （「小さいはずが積み重なって大きくなっていた」ことに実行中に気づけるようにする）
 */

const EGRESS_WARN_BYTES = 20 * 1024 * 1024; // 20MB: このプロセスの累計転送量がここを超えたら警告
const EGRESS_ABORT_BYTES = 100 * 1024 * 1024; // 100MB: ここを超えたら強制停止（暴走防止）

let cumulativeBytes = 0;
let warned = false;

function trackEgress(byteLength, context) {
  cumulativeBytes += byteLength;
  if (cumulativeBytes > EGRESS_ABORT_BYTES) {
    throw new Error(
      `Egressガード: このプロセスの累計転送量が${(cumulativeBytes / 1024 / 1024).toFixed(1)}MBに` +
        `達したため強制停止しました（直近: ${context}）。想定より大きなデータを転送していないか確認してください。`,
    );
  }
  if (!warned && cumulativeBytes > EGRESS_WARN_BYTES) {
    warned = true;
    console.warn(
      `⚠ Egressガード: このプロセスの累計転送量が${(cumulativeBytes / 1024 / 1024).toFixed(1)}MBを` +
        `超えました（直近: ${context}）。想定内か確認してください。`,
    );
  }
}

async function withRetry(fn, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !String(err.message).includes(" 503 ")) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export function createSupabaseRest({ url, anonKey }) {
  if (!url || !anonKey) throw new Error("createSupabaseRest: url/anonKeyが必要です");

  async function request(path, { method = "GET", body, prefer } = {}) {
    return withRetry(async () => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      trackEgress(Buffer.byteLength(text, "utf-8"), `${method} ${path}`);
      if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
      return text ? JSON.parse(text) : null;
    });
  }

  return {
    async get(path) {
      return request(path);
    },
    /** returnRows: trueにした場合のみ書き込んだ行を応答で受け取る（デフォルトはreturn=minimal） */
    async insert(table, rows, { returnRows = false } = {}) {
      return request(table, {
        method: "POST",
        body: rows,
        prefer: returnRows ? "return=representation" : "return=minimal",
      });
    },
    async upsert(table, rows, conflictColumn, { returnRows = true } = {}) {
      return request(`${table}?on_conflict=${conflictColumn}`, {
        method: "POST",
        body: rows,
        prefer: `resolution=merge-duplicates,${returnRows ? "return=representation" : "return=minimal"}`,
      });
    },
    getCumulativeBytes: () => cumulativeBytes,
  };
}
