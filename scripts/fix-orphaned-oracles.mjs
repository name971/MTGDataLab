/**
 * card_oracles には存在するのに cards（代表プリント）が1件も無いoracle_idを一括で埋め直す。
 * import-full-catalog.mjs実行時か、その後のrebuild-representative-prints.mjs実行時（クラッシュ後の
 * 再開処理を含む）に何らかの理由で欠落したもの（37273件中14497件で発生）。
 * rebuild-representative-prints.mjs（1oracleずつGET+DELETE+POST）より高速にするため、
 * バルクデータのインデックスを1回読み込んだ後はバッチでupsertする。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/fix-orphaned-oracles.mjs
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
  findJapanesePrint,
  toCardRow,
} from "./lib/scryfallBulk.mjs";

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
  const index = await loadIndex();

  const oracles = await supabaseGet("card_oracles?select=oracle_id,name");
  const cardsRows = await supabaseGet("cards?select=oracle_id&lang=eq.en");
  const withCards = new Set(cardsRows.map((c) => c.oracle_id));
  const orphaned = oracles.filter((o) => !withCards.has(o.oracle_id));
  console.log(`card_oracles: ${oracles.length}件中 cards欠落: ${orphaned.length}件`);

  const cardRows = [];
  let notFound = 0;
  for (const o of orphaned) {
    const enCard = findEnglishCard(index, o.name);
    if (!enCard) {
      notFound++;
      continue;
    }
    const jaCard = findJapanesePrint(index, enCard.oracle_id, enCard.set, enCard.collector_number);
    cardRows.push(toCardRow(enCard, o.oracle_id));
    if (jaCard) cardRows.push(toCardRow(jaCard, o.oracle_id));
  }
  console.log(`解決: ${orphaned.length - notFound}件、未検出: ${notFound}件、投入cards行: ${cardRows.length}件`);

  await supabaseUpsert("cards", cardRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
