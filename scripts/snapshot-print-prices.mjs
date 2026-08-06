/**
 * card_prints（全プリント、db/schema.sql参照）の日次USD価格をScryfallバルクデータから取得し、
 * 2箇所に書き込む:
 *   1. card_print_current_prices（Postgres）: 「今の価格」だけを1プリント1行で持つキャッシュ。
 *      毎日上書きするだけなのでプリント数に比例するだけで、日数が経っても増えない。
 *   2. print_price_history_archive（Cloudflare D1）: 日次の価格履歴そのもの。前日と同じ値なら
 *      書かない差分方式（サンプル調査で実際に変化する日は3〜4割程度だった）。
 *
 * 以前はcard_print_prices（Postgres、プリント単位JSONB追記式）に書いていたが、無期限に
 * 増え続けてSupabase無料枠（500MB）を圧迫し続けていた（DB容量超過対応、db/schema.sql参照）。
 * 新規の書き込みはもう行わない。既存の古い行はscripts/archive-old-print-prices.mjsが
 * 60日経過後にD1へ吸い出して削除するため、時間経過とともに空になっていく。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/snapshot-print-prices.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBulkData, loadIndex, findPriceById } from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 150; // 1回のINSERT文に含める行数（SQLiteのバインド変数上限対策）

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
  const dir = mkdtempSync(join(tmpdir(), "d1-snapshot-"));
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

// `wrangler d1 execute`はサブプロセス起動のオーバーヘッドが大きいため、INSERT文1つごとに
// 毎回呼び出すと（9万行規模だと数百回起動になり）非現実的に遅くなる。1回の--fileで
// 複数のINSERT文をまとめて実行できるため、STATEMENTS_PER_FILE個ずつSQLファイルにまとめてから
// 実行回数を絞る（wrangler呼び出し自体は数十回程度に収める）。
const STATEMENTS_PER_FILE = 50;

function insertArchiveRows(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk
      .map((r) => `(${sqlLiteral(r.scryfall_id)}, ${sqlLiteral(r.date)}, ${sqlLiteral(r.usd)}, ${sqlLiteral(r.usd_foil)})`)
      .join(",\n  ");
    statements.push(
      `INSERT INTO print_price_history_archive (scryfall_id, date, usd, usd_foil) VALUES\n  ${values}\nON CONFLICT (scryfall_id, date) DO UPDATE SET usd=excluded.usd, usd_foil=excluded.usd_foil;`,
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

  await ensureBulkData();
  const index = await loadIndex();

  const prints = await supabaseGet("card_prints?select=scryfall_id,oracle_id&order=scryfall_id.asc");
  console.log(`対象プリント: ${prints.length}件`);

  console.log("現在価格キャッシュ（card_print_current_prices）を取得中...");
  const currentRows = await supabaseGet(
    "card_print_current_prices?select=scryfall_id,usd,usd_foil&order=scryfall_id.asc",
  );
  const currentByScryfallId = new Map(
    currentRows.map((r) => [r.scryfall_id, { usd: r.usd, usd_foil: r.usd_foil }]),
  );

  const cacheRows = [];
  const archiveRows = []; // 前日と値が変わったプリントだけ
  let priced = 0;
  let foilPriced = 0;
  for (const p of prints) {
    const price = findPriceById(index, p.scryfall_id);
    const usd = price?.usd != null ? parseFloat(price.usd) : null;
    const usdFoil = price?.usd_foil != null ? parseFloat(price.usd_foil) : null;
    if (usd === null && usdFoil === null) continue; // 価格が全く付いていないプリントは対象外

    if (usd !== null) priced++;
    if (usdFoil !== null) foilPriced++;

    cacheRows.push({ scryfall_id: p.scryfall_id, oracle_id: p.oracle_id, date: today, usd, usd_foil: usdFoil });

    const prev = currentByScryfallId.get(p.scryfall_id);
    const changed = !prev || usd !== prev.usd || usdFoil !== prev.usd_foil;
    if (changed) {
      archiveRows.push({ scryfall_id: p.scryfall_id, date: today, usd, usd_foil: usdFoil });
    }
  }
  console.log(`価格あり: ${priced}件（うちFoil ${foilPriced}件）、うち変化あり: ${archiveRows.length}件`);

  console.log("D1（print_price_history_archive）へ差分を書き込み中...");
  if (archiveRows.length > 0) insertArchiveRows(archiveRows);

  console.log("Postgres（card_print_current_prices）を更新中...");
  await supabaseUpsert("card_print_current_prices", cacheRows, "scryfall_id");

  console.log(`\n完了: 現在価格キャッシュ${cacheRows.length}件更新、D1へ${archiveRows.length}件書き込み`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
