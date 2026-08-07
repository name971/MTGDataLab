/**
 * card_print_current_prices（Postgres、各プリントの「今の価格」キャッシュ、
 * scripts/snapshot-print-prices.mjsが日次更新）から、オラクル単位で「今、全プリント中の
 * 最安値」を計算し、2箇所に書き込む:
 *   1. card_current_prices（Postgres）: 「今の価格」だけを1オラクル1行で持つキャッシュ。
 *      カード詳細ページのメイン価格等、頻繁に読まれる箇所はここを見る。
 *   2. price_history_archive（Cloudflare D1）: 今日分を1日ぶんだけ追記する日次履歴
 *      （価格推移グラフ用）。
 *
 * 以前はcard_print_prices（Postgres、プリント単位JSONB全履歴）を毎回丸ごとスキャンして
 * 過去に遡って全期間を再計算する設計だったが、card_print_current_prices自体が既に
 * 「各プリントの最新価格」を保持しているため、その必要が無くなった（DB容量超過対応）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-cheapest-price-snapshots.mjs
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

const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 150;

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

async function supabaseUpsert(table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-cheapest-"));
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

// wranglerのサブプロセス起動オーバーヘッドを抑えるため、複数のINSERT文を1ファイルにまとめて
// 実行回数を絞る（scripts/snapshot-print-prices.mjsと同じ理由）。
const STATEMENTS_PER_FILE = 50;

function insertArchiveRows(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
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

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  console.log("為替レートを取得中...");
  const rateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy&order=date.desc&limit=1");
  const rate = rateRows[0] ? Number(rateRows[0].usd_to_jpy) : null;
  if (!rate) {
    console.error("為替レートが1件も無いため中断します。scripts/snapshot-exchange-rates.mjsを先に実行してください。");
    process.exit(1);
  }
  console.log(`使用するレート: ${rateRows[0].date} 時点 ${rate}円/$`);

  console.log("使用不可プリントの一覧を取得中...");
  const notLegalRows = await supabaseGet("card_prints?not_tournament_legal=eq.true&select=scryfall_id");
  const notTournamentLegalIds = new Set(notLegalRows.map((r) => r.scryfall_id));
  console.log(`${notTournamentLegalIds.size}件が使用不可プリント（最安値集計から除外）`);

  console.log("プリント単位の現在価格キャッシュ（card_print_current_prices）を取得中...");
  const printRows = await supabaseGet(
    "card_print_current_prices?select=scryfall_id,oracle_id,usd,usd_foil",
  );
  console.log(`${printRows.length}件のプリント現在価格を走査`);

  // オラクル単位で最安値（通常・Foilそれぞれ）を求める
  const bestByOracle = new Map(); // oracle_id -> { normal: {usd, scryfallId}|null, foil: {...}|null }
  for (const row of printRows) {
    if (notTournamentLegalIds.has(row.scryfall_id)) continue;
    const entry = bestByOracle.get(row.oracle_id) ?? { normal: null, foil: null };
    if (row.usd != null && (!entry.normal || row.usd < entry.normal.usd)) {
      entry.normal = { usd: Number(row.usd), scryfallId: row.scryfall_id };
    }
    if (row.usd_foil != null && (!entry.foil || row.usd_foil < entry.foil.usd)) {
      entry.foil = { usd: Number(row.usd_foil), scryfallId: row.scryfall_id };
    }
    bestByOracle.set(row.oracle_id, entry);
  }

  const cacheRows = [];
  const archiveRows = [];
  for (const [oracleId, entry] of bestByOracle) {
    if (!entry.normal && !entry.foil) continue;
    const jpyEst = entry.normal ? Math.round(entry.normal.usd * rate * 100) / 100 : null;
    const jpyEstFoil = entry.foil ? Math.round(entry.foil.usd * rate * 100) / 100 : null;
    cacheRows.push({
      oracle_id: oracleId,
      date: today,
      scryfall_id: entry.normal?.scryfallId ?? null,
      usd: entry.normal?.usd ?? null,
      jpy_est: jpyEst,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
      usd_foil: entry.foil?.usd ?? null,
      jpy_est_foil: jpyEstFoil,
    });
    archiveRows.push({
      oracle_id: oracleId,
      date: today,
      jpy_est: jpyEst,
      jpy_est_foil: jpyEstFoil,
      scryfall_id: entry.normal?.scryfallId ?? null,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
    });
  }

  console.log(`${cacheRows.length}件（オラクル単位）の最安値を計算完了`);

  console.log("Postgres（card_current_prices）を更新中...");
  await supabaseUpsert("card_current_prices", cacheRows, "oracle_id");

  console.log("D1（price_history_archive）へ今日分を書き込み中...");
  insertArchiveRows(archiveRows);

  console.log(`\n完了: 現在価格キャッシュ${cacheRows.length}件更新、D1へ今日分${archiveRows.length}件書き込み`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
