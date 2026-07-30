/**
 * 既存のcards（lang='ja'）行にprinted_type_line（タイプ行の日本語訳、db/schema.sql参照）を
 * 後付けで埋める。type_lineカラムは常に英語（Scryfallの生データがそうなっているため）で、
 * 日本語版のタイプ行はprinted_type_lineという別フィールドに入っているのに、これまで
 * このカラム自体が無くカード詳細ページのタイプ行が日本語版でも常に英語表示になっていた。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-printed-type-line.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE, toCardRow } from "./lib/scryfallBulk.mjs";

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

const UPSERT_CHUNK = 200;

async function supabaseUpsert(table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
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

  const jaCards = await supabaseGet(
    "cards?select=scryfall_id,oracle_id,printed_type_line&lang=eq.ja&order=scryfall_id.asc",
  );
  const missing = jaCards.filter((c) => !c.printed_type_line);
  const oracleByScryfallId = new Map(missing.map((c) => [c.scryfall_id, c.oracle_id]));
  console.log(`ja cards: ${jaCards.length}件中 printed_type_line欠落: ${missing.length}件`);

  const updateRows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "ja" || !oracleByScryfallId.has(raw.id)) return;
    updateRows.push(toCardRow(raw, oracleByScryfallId.get(raw.id)));
  });
  console.log(`解決: ${updateRows.length}件`);

  await supabaseUpsert("cards", updateRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
