/**
 * card_oracles には存在するのに cards（代表プリント）が1件も無いoracle_idを一括で埋め直す。
 * import-full-catalog.mjs実行時か、その後のrebuild-representative-prints.mjs実行時（クラッシュ後の
 * 再開処理を含む）に何らかの理由で欠落したもの（37273件中14496件で発生）。
 *
 * findEnglishCard（名前検索）は使わない: 同じ名前を持つ複数のoracle_id（例: 本物のBrainstormと
 * Art Series版のBrainstorm）が存在する場合、名前検索は常に同じ「一番良い1件」を返してしまい、
 * 2つの別oracle_idに同じscryfall_idを代表として割り当てようとしてPKが衝突する
 * （実際に発生: "ON CONFLICT DO UPDATE command cannot affect row a second time"）。
 * 代わりにバルクデータを直接ストリーミングし、raw.oracle_idが対象集合に含まれる行だけを見て
 * oracle_idベースで代表プリントを選び直す（rebuild-card-prints.mjs / import-full-catalog.mjsと同じ方式）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/fix-orphaned-oracles.mjs
 */

import {
  ensureBulkData,
  loadIndex,
  forEachJsonArrayObject,
  DATA_FILE,
  isBetterRepresentative,
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
  // 同じscryfall_idが1回のINSERT内に複数回現れると
  // "ON CONFLICT DO UPDATE command cannot affect row a second time"で失敗するため、
  // 万一の重複（別oracle_idが同じ代表プリントを指す等）は最初の1件だけ残す
  const deduped = [...new Map(rows.map((r) => [r.scryfall_id, r])).values()];
  for (let i = 0; i < deduped.length; i += PAGE_SIZE) {
    const chunk = deduped.slice(i, i + PAGE_SIZE);
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
  return deduped.length;
}

async function main() {
  await ensureBulkData();

  const oracles = await supabaseGet("card_oracles?select=oracle_id,name");
  const cardsRows = await supabaseGet("cards?select=oracle_id&lang=eq.en");
  const withCards = new Set(cardsRows.map((c) => c.oracle_id));
  const orphanedIds = new Set(oracles.filter((o) => !withCards.has(o.oracle_id)).map((o) => o.oracle_id));
  console.log(`card_oracles: ${oracles.length}件中 cards欠落: ${orphanedIds.size}件`);

  const bestEnByOracle = new Map();
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || raw.digital || !raw.oracle_id) return;
    if (!orphanedIds.has(raw.oracle_id)) return;
    const current = bestEnByOracle.get(raw.oracle_id);
    if (isBetterRepresentative(raw, current)) bestEnByOracle.set(raw.oracle_id, raw);
  });
  console.log(`バルクデータから解決: ${bestEnByOracle.size}/${orphanedIds.size}件`);

  // 日本語版プリントの検索（同一プリント限定）はloadIndex()のbyOracleIdJaを使う
  const index = await loadIndex();

  const cardRows = [];
  for (const [oracleId, enCard] of bestEnByOracle) {
    const jaCard = findJapanesePrint(index, oracleId, enCard.set, enCard.collector_number);
    cardRows.push(toCardRow(enCard, oracleId));
    if (jaCard) cardRows.push(toCardRow(jaCard, oracleId));
  }

  const saved = await supabaseUpsert("cards", cardRows, "scryfall_id");
  console.log(`\n完了: cards ${saved}件を保存（重複除去前 ${cardRows.length}件）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
