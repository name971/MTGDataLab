/**
 * card_prints（全プリント、db/schema.sql参照）の日次USD価格をScryfallバルクデータから取得し、
 * 2箇所に書き込む:
 *   1. card_print_current_prices（Postgres）: 「今の価格」だけを1プリント1行で持つキャッシュ。
 *      毎日上書きするだけなのでプリント数に比例するだけで、日数が経っても増えない。
 *   2. print-price-history（Cloudflare R2、月次NDJSON.gz、scripts/lib/r2PriceArchive.mjs）:
 *      日次の価格履歴そのもの。前日と同じ値なら書かない差分方式（サンプル調査で実際に
 *      変化する日は3〜4割程度だった）。以前はCloudflare D1に書いていたが、D1無料枠の
 *      日次読み書き行数上限に達したため、リクエスト数課金のR2へ移行した。
 *
 * 以前はcard_print_prices（Postgres、プリント単位JSONB追記式）に書いていたが、無期限に
 * 増え続けてSupabase無料枠（500MB）を圧迫し続けていた（DB容量超過対応、db/schema.sql参照）。
 * 新規の書き込みはもう行わない。既存の古い行はscripts/archive-old-print-prices.mjsが
 * 60日経過後にR2へ吸い出して削除するため、時間経過とともに空になっていく。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/snapshot-print-prices.mjs
 */

import { ensureBulkData, buildPriceIndex, findPriceById } from "./lib/scryfallBulk.mjs";
import { mergePrintPriceRows } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

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

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  await ensureBulkData();
  const index = await buildPriceIndex();

  const prints = await supabaseGet("card_prints?select=scryfall_id,oracle_id&order=scryfall_id.asc");
  console.log(`対象プリント: ${prints.length}件`);

  const cacheRows = [];
  const archiveRows = [];
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
    archiveRows.push({ scryfall_id: p.scryfall_id, date: today, usd, usd_foil: usdFoil });
  }
  console.log(`価格あり: ${priced}件（うちFoil ${foilPriced}件）`);

  // 「前日と変わったか」はcard_print_current_prices（Supabase、日次以外の理由でも更新されうる
  // 「今の価格」キャッシュ）と比較せず、全件をR2へ渡してR2側の比較・スキップ判定
  // （scripts/lib/r2PriceArchive.mjsのmergeCardFile）に委ねる。Supabase側と比較する方式だと、
  // 何らかの理由でcard_print_current_pricesだけ先に今日の値へ更新されてしまった場合
  // （同日に複数回実行した、処理が部分的に失敗した等）、R2へは一度も今日の日付が
  // 書き込まれないまま「変化なし」と誤判定される事故が起きる（実際にオラクル単位の方で発生し、
  // 継続注目カード（card_streaks）の価格カテゴリが常に0件になっていた）。
  console.log("R2（print-price-history）へ書き込み中（変化が無いプリントはR2側でスキップ）...");
  if (archiveRows.length > 0) await mergePrintPriceRows(archiveRows);

  console.log("Postgres（card_print_current_prices）を更新中...");
  await supabaseUpsert("card_print_current_prices", cacheRows, "scryfall_id");

  console.log(`\n完了: 現在価格キャッシュ${cacheRows.length}件更新、R2へ${archiveRows.length}件処理（変化分のみ実書き込み）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
