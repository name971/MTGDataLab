/**
 * 既存のcards行にpower/toughness（db/schema.sql参照、新規追加カラム）を後付けで埋める。
 * scripts/lib/scryfallBulk.mjsのtoCardRowは今後の新規投入分には自動でpower/toughnessを
 * 含めるようになったが、既に登録済みの行にはこのバックフィルが必要。
 * scryfall_id単位で対象を絞り、バルクデータを1回ストリーミングして該当分だけ拾う。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-power-toughness.mjs
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

// cards行はlegalities(JSONB)等カラムが多く、1000件単位のUPSERTだと本番DBで
// statement timeoutになった（実際に22000件目で発生）。UPSERT時だけ小さいチャンクにする。
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

  // order句が無いとページング中の並び順が不安定になることがある（過去に実際に事故が起きた
  // ため全スクリプト共通で対応済み）。安定した一意キーであるscryfall_idで並べる。
  const cards = await supabaseGet("cards?select=scryfall_id,oracle_id&order=scryfall_id.asc");
  const oracleByScryfallId = new Map(cards.map((c) => [c.scryfall_id, c.oracle_id]));
  console.log(`cards: ${cards.length}件を対象にpower/toughnessを補完`);

  const updateRows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (!oracleByScryfallId.has(raw.id)) return;
    updateRows.push(toCardRow(raw, oracleByScryfallId.get(raw.id)));
  });
  console.log(`バルクデータから解決: ${updateRows.length}/${cards.length}件`);

  await supabaseUpsert("cards", updateRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
