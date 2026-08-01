/**
 * 既存のcards行にis_universes_beyond（db/schema.sql）を後付けで埋める。
 * これまでpromo_typesを保存していなかった（scryfallBulk.mjsのslimCard/toCardRowが未対応）ため、
 * 過去にインポートした行は全てfalseのまま=正しく判定できていなかった。
 *
 * 実行前にSupabaseで以下を実行しておくこと:
 *   ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_universes_beyond BOOLEAN DEFAULT false;
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-universes-beyond.mjs
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

  const existingCards = await supabaseGet("cards?select=scryfall_id,oracle_id&order=scryfall_id.asc");
  const oracleByScryfallId = new Map(existingCards.map((c) => [c.scryfall_id, c.oracle_id]));
  console.log(`既存cards: ${existingCards.length}件`);

  const updateRows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (!oracleByScryfallId.has(raw.id)) return;
    updateRows.push(toCardRow(raw, oracleByScryfallId.get(raw.id)));
  });
  console.log(`解決: ${updateRows.length}件（うちUB版: ${updateRows.filter((r) => r.is_universes_beyond).length}件）`);

  await supabaseUpsert("cards", updateRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
