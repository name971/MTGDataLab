/**
 * card_prints（全プリント、db/schema.sql参照）の日次USD価格をScryfallバルクデータから取得し、
 * card_print_pricesに追記する。card_price_snapshots（代表プリントのみ、1日1行を積み上げる方式）
 * と違い、DB容量（無料枠500MB）を圧迫しないよう「1プリント=1行、日付ごとの価格はJSONBに追記」
 * という設計にしている（db/schema.sqlのコメント参照）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/snapshot-print-prices.mjs
 */

import { ensureBulkData, loadIndex, findPriceById } from "./lib/scryfallBulk.mjs";

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
  const index = await loadIndex();

  const prints = await supabaseGet("card_prints?select=scryfall_id,oracle_id");
  console.log(`対象プリント: ${prints.length}件`);

  // 既存のJSONB（これまでの日付分）を取得し、今日分を追記した上で丸ごと上書きする
  // （PostgRESTのupsertはJSONBの部分マージができないため、クライアント側でマージする）
  const existing = await supabaseGet("card_print_prices?select=scryfall_id,prices");
  const pricesByScryfallId = new Map(existing.map((r) => [r.scryfall_id, r.prices ?? {}]));

  const rows = [];
  let priced = 0;
  for (const p of prints) {
    const price = findPriceById(index, p.scryfall_id);
    const usd = price?.usd != null ? parseFloat(price.usd) : null;
    if (usd === null) continue; // 価格が付いていないプリントは追記しない（無駄な空エントリを避ける）

    const prices = pricesByScryfallId.get(p.scryfall_id) ?? {};
    prices[today] = usd;
    rows.push({ scryfall_id: p.scryfall_id, oracle_id: p.oracle_id, prices });
    priced++;
  }
  console.log(`価格あり: ${priced}件を保存中...`);

  await supabaseUpsert("card_print_prices", rows, "scryfall_id");
  console.log(`\n完了: card_print_prices ${rows.length}件を更新`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
