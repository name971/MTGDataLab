/**
 * card_cheapest_price_snapshots（Supabase）のうち、ARCHIVE_CUTOFF_DAYSより古い行を
 * Cloudflare D1（jp-mtgstocks-archive、無料枠5GB）へ移し、Supabase側からは削除する。
 * Supabase無料枠（Postgres 500MB）を圧迫し続けている一番の要因がこのテーブルの
 * 無期限成長のため、「直近だけSupabaseに残す」形に切り替える。
 *
 * カード詳細ページの価格推移グラフ「全期間」表示は、直近をSupabase・それ以前をD1から
 * 取得して結合する（src/lib/dbCheapestPrice.ts）ため、アーカイブしても表示上のデータは
 * 失われない。
 *
 * D1への書き込みは`wrangler d1 execute`（生成したSQLファイルを流し込む）で行う。
 * ローカル実行時はwranglerのOAuthセッション、CI実行時はCLOUDFLARE_API_TOKEN環境変数
 * （wranglerが自動で拾う）で認証する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/archive-old-price-snapshots.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// アプリのcard_cheapest_price_snapshots関連クエリ（streak計算・価格変化率等）が実際に
// 参照するのは直近60日程度（compute-card-streaks.mjsのSTREAK_LOOKBACK_DAYS参照）。
// 以前は安全マージンを取って90日にしていたが、増加ペースに対して緩すぎたため、
// streak計算が必要とするちょうど60日（マージン無し）まで縮めた。
const ARCHIVE_CUTOFF_DAYS = 0; // 一時的に全件移行用
const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 200; // 1回のINSERT文に含める行数（SQLiteのバインド変数上限対策）

async function supabaseGetAll(path) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-archive-"));
  const filePath = join(dir, "batch.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`],
      { stdio: "inherit", shell: true },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --command=にSQLをインライン指定すると、Windowsのcmd.exe（shell:true経由）がSQL中の
// "<"をリダイレクト記号として解釈してしまい壊れる（実際に検証クエリで発生した）。
// d1ExecuteFileと同様、一時ファイル経由の--fileにすることでシェルの特殊文字を回避する。
function d1QueryJson(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-query-"));
  const filePath = join(dir, "query.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`, "--json"],
      { encoding: "utf-8", shell: true },
    );
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// wranglerのサブプロセス起動オーバーヘッドを抑えるため、複数のINSERT文を1ファイルにまとめて
// 実行回数を絞る（scripts/snapshot-print-prices.mjsと同じ理由）。
const STATEMENTS_PER_FILE = 50;

function insertBatchToD1(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk
      .map(
        (r) =>
          `(${sqlLiteral(r.oracle_id)}, ${sqlLiteral(r.date)}, ${sqlLiteral(r.jpy_est)}, ${sqlLiteral(r.jpy_est_foil)})`,
      )
      .join(",\n  ");
    statements.push(
      `INSERT INTO price_history_archive (oracle_id, date, jpy_est, jpy_est_foil) VALUES\n  ${values}\nON CONFLICT (oracle_id, date) DO UPDATE SET jpy_est=excluded.jpy_est, jpy_est_foil=excluded.jpy_est_foil;`,
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
    const fileStatements = statements.slice(i, i + STATEMENTS_PER_FILE);
    d1ExecuteFile(fileStatements.join("\n"));
    console.log(
      `  ...D1書き込み ${Math.min(i + STATEMENTS_PER_FILE, statements.length)}/${statements.length}バッチ`,
    );
  }
}

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_CUTOFF_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`${cutoffStr}より古いcard_cheapest_price_snapshotsを取得中...`);
  const oldRows = await supabaseGetAll(
    `card_cheapest_price_snapshots?select=oracle_id,date,jpy_est,jpy_est_foil&date=lt.${cutoffStr}`,
  );
  console.log(`対象: ${oldRows.length}行`);

  if (oldRows.length === 0) {
    console.log("アーカイブ対象がありません。終了します。");
    return;
  }

  console.log("D1へ書き込み中...");
  insertBatchToD1(oldRows);

  // D1側に書き込めた件数を検証してからでないとSupabase側を消さない
  const countJson = d1QueryJson(
    `SELECT COUNT(*) AS c FROM price_history_archive WHERE date < '${cutoffStr}'`,
  );
  const archivedCount = countJson[0]?.results?.[0]?.c ?? 0;
  console.log(`D1側の確認: date < ${cutoffStr} の行数 = ${archivedCount}`);
  if (archivedCount < oldRows.length) {
    throw new Error(
      `D1への書き込み件数(${archivedCount})がSupabase取得件数(${oldRows.length})を下回っています。` +
        "Supabase側の削除は行わず中断します。",
    );
  }

  console.log("Supabase側の古い行を削除中...");
  await supabaseDelete(`card_cheapest_price_snapshots?date=lt.${cutoffStr}`);

  console.log(`\n完了: ${oldRows.length}行をD1へアーカイブし、Supabaseから削除しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
