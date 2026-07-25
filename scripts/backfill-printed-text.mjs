/**
 * 既存のcards（lang='ja'）行にprinted_text_ja（ルールテキストの日本語訳）を後付けで埋める。
 * scryfall_id単位で対象を絞り、バルクデータを1回ストリーミングして該当分だけ拾う。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-printed-text.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE, combinedPrintedText } from "./lib/scryfallBulk.mjs";

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
    if (!res.ok) throw new Error(`${table} upsert failed (chunk ${i}): ${res.status} ${await res.text()}`);
  }
}

async function main() {
  await ensureBulkData();

  const jaCards = await supabaseGet("cards?select=scryfall_id,printed_text_ja&lang=eq.ja");
  const missingIds = new Set(jaCards.filter((c) => !c.printed_text_ja).map((c) => c.scryfall_id));
  console.log(`ja cards: ${jaCards.length}件中 printed_text_ja欠落: ${missingIds.size}件`);

  const updateRows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "ja" || !missingIds.has(raw.id)) return;
    const text = combinedPrintedText(raw);
    if (text) updateRows.push({ scryfall_id: raw.id, printed_text_ja: text });
  });
  console.log(`解決: ${updateRows.length}件`);

  await supabaseUpsert("cards", updateRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
