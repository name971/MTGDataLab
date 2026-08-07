/**
 * 【一時利用・使い捨てスクリプト】price_history_archive（D1、オラクル単位の全プリント横断
 * 最安値）のうち、scryfall_id列追加前の一括移行分（2026-07-25〜2026-08-06）を、
 * print_price_history_archive（D1、プリント単位・差分書き込み）から前方埋め（forward-fill）
 * して正しく再計算する。
 *
 * これまでの復元方法（backfill-price-history-scryfall-ids.mjs）は「その日ちょうど価格が
 * 変わって記録があるプリントだけ」を見て最安値を決めていたが、print_price_history_archiveは
 * 差分書き込み（価格が変わった日だけ記録）のため、実際は在庫があるのにその日たまたま記録が
 * 無いプリントが除外されてしまい、誤ったプリントが「最安」に選ばれることがあった
 * （実例: Mox Ruby、No More Lies）。
 *
 * こちらは日付順に処理しながら「プリントごとの直近の既知価格」を引き継ぐマップを更新し続け、
 * 各日の時点でそのマップから使用可能プリントだけの最安値を計算する。D1のアーカイブが
 * 2026-07-25開始でそれ以前の履歴が無いため、07-25時点の初期値としてcard_print_current_prices
 * （Postgres、現在価格）を暫定ベースラインに使い、以降は実際の差分記録で上書きしていく
 * （ベースラインのまま変わらないプリントは「その期間ずっと現在と同じ価格だった」という
 * 最善の推定になる。過去の変動そのものは記録が無い以上復元できない）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/rebuild-price-history-forward-fill.mjs
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
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定してください");
  process.exit(1);
}

const START_DATE = "2026-07-25";
const END_DATE = "2026-08-06";

const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 150;
const STATEMENTS_PER_FILE = 50;

async function supabaseGet(path) {
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

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-rebuild-"));
  const filePath = join(dir, "batch.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execFileSync(
          "npx",
          ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`],
          { stdio: "inherit", shell: true },
        );
        return;
      } catch (err) {
        if (attempt === 3) throw err;
        console.error(`  ...D1書き込み失敗（試行${attempt}）、5秒後にリトライします`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function d1QueryViaCli(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--json", `--command="${sql}"`],
    { shell: true, encoding: "utf-8", maxBuffer: 1024 * 1024 * 200 },
  );
  const jsonStart = out.indexOf("[");
  const body = JSON.parse(out.slice(jsonStart));
  return body[0]?.results ?? [];
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log("card_prints（scryfall_id→oracle_id、使用不可フラグ）を取得中...");
  const printRows = await supabaseGet("card_prints?select=scryfall_id,oracle_id,not_tournament_legal");
  const oracleByScryfallId = new Map();
  for (const p of printRows) {
    if (p.not_tournament_legal) continue;
    oracleByScryfallId.set(p.scryfall_id, p.oracle_id);
  }
  console.log(`${oracleByScryfallId.size}件のプリント（使用可能分）を走査対象に`);

  console.log("card_print_current_prices（暫定ベースライン）を取得中...");
  const currentPriceRows = await supabaseGet("card_print_current_prices?select=scryfall_id,usd,usd_foil");
  // scryfall_id -> { usd, usdFoil }（現在の既知価格。以降の日付処理でprint_price_history_archiveの
  // 実データが見つかり次第上書きされる）
  const currentPriceBySrcId = new Map();
  for (const r of currentPriceRows) {
    if (!oracleByScryfallId.has(r.scryfall_id)) continue;
    currentPriceBySrcId.set(r.scryfall_id, {
      usd: r.usd !== null ? Number(r.usd) : null,
      usdFoil: r.usd_foil !== null ? Number(r.usd_foil) : null,
    });
  }
  console.log(`${currentPriceBySrcId.size}件のベースライン価格を用意`);

  console.log("exchange_rates（日付ごとの為替レート）を取得中...");
  const rateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy&order=date.asc");
  const rateByDate = new Map(rateRows.map((r) => [r.date, Number(r.usd_to_jpy)]));
  function rateForDate(date) {
    let best = null;
    for (const [d, rate] of rateByDate) {
      if (d <= date && (best === null || d > best.date)) best = { date: d, rate };
    }
    return best?.rate ?? null;
  }

  const dates = [];
  for (let d = START_DATE; d <= END_DATE; d = addDays(d, 1)) dates.push(d);
  console.log(`対象日数: ${dates.length}日（${START_DATE}〜${END_DATE}）`);

  let totalWritten = 0;

  for (const date of dates) {
    console.log(`\n--- ${date} ---`);
    // その日の差分記録で「直近の既知価格」マップを更新する（前方埋めの本体）
    const deltaRows = d1QueryViaCli(
      `SELECT scryfall_id, usd, usd_foil FROM print_price_history_archive WHERE date = '${date}'`,
    );
    for (const row of deltaRows) {
      if (!oracleByScryfallId.has(row.scryfall_id)) continue;
      currentPriceBySrcId.set(row.scryfall_id, {
        usd: row.usd !== null ? Number(row.usd) : null,
        usdFoil: row.usd_foil !== null ? Number(row.usd_foil) : null,
      });
    }
    console.log(`  差分 ${deltaRows.length}件を反映`);

    const rate = rateForDate(date);
    if (!rate) {
      console.log("  為替レートが無いためこの日は書き込みスキップ");
      continue;
    }

    // 現時点の「直近の既知価格」マップ全体から、オラクルごとの最安値（通常・Foil）を計算する
    const bestByOracle = new Map();
    for (const [scryfallId, price] of currentPriceBySrcId) {
      const oracleId = oracleByScryfallId.get(scryfallId);
      const entry = bestByOracle.get(oracleId) ?? { normal: null, foil: null };
      if (price.usd != null && (!entry.normal || price.usd < entry.normal.usd)) {
        entry.normal = { usd: price.usd, scryfallId };
      }
      if (price.usdFoil != null && (!entry.foil || price.usdFoil < entry.foil.usd)) {
        entry.foil = { usd: price.usdFoil, scryfallId };
      }
      bestByOracle.set(oracleId, entry);
    }

    const updateRows = [];
    for (const [oracleId, e] of bestByOracle) {
      if (!e.normal && !e.foil) continue;
      updateRows.push({
        oracle_id: oracleId,
        date,
        jpy_est: e.normal ? Math.round(e.normal.usd * rate * 100) / 100 : null,
        jpy_est_foil: e.foil ? Math.round(e.foil.usd * rate * 100) / 100 : null,
        scryfall_id: e.normal?.scryfallId ?? null,
        scryfall_id_foil: e.foil?.scryfallId ?? null,
      });
    }
    console.log(`  ${updateRows.length}件のオラクルを再計算値で更新`);
    totalWritten += updateRows.length;

    const statements = [];
    for (let i = 0; i < updateRows.length; i += SQL_BATCH_SIZE) {
      const chunk = updateRows.slice(i, i + SQL_BATCH_SIZE);
      const values = chunk
        .map(
          (r) =>
            `(${sqlLiteral(r.oracle_id)}, ${sqlLiteral(r.date)}, ${sqlLiteral(r.jpy_est)}, ${sqlLiteral(r.jpy_est_foil)}, ${sqlLiteral(r.scryfall_id)}, ${sqlLiteral(r.scryfall_id_foil)})`,
        )
        .join(",\n  ");
      statements.push(
        `INSERT INTO price_history_archive (oracle_id, date, jpy_est, jpy_est_foil, scryfall_id, scryfall_id_foil) VALUES\n  ${values}\nON CONFLICT (oracle_id, date) DO UPDATE SET jpy_est=excluded.jpy_est, jpy_est_foil=excluded.jpy_est_foil, scryfall_id=excluded.scryfall_id, scryfall_id_foil=excluded.scryfall_id_foil;`,
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

  console.log(`\n完了。合計${totalWritten}件のオラクル×日付を再計算・書き込みました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
