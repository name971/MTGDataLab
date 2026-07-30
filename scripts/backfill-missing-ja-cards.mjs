/**
 * card_oraclesにprinted_name_ja（日本語名）はあるのに、cardsテーブルに日本語版プリントの行が
 * 1件も無いオラクルを一括で直す。
 *
 * 原因: findJapanesePrint（scripts/lib/scryfallBulk.mjs）は「英語の代表プリントと同じセット・
 * コレクター番号」の日本語版しか探さない。日本語版が別セット（再録商品等）にしか存在しない
 * カードだとこの一致条件を満たせずcardsへの日本語行が作られない。一方card_oracles.printed_name_ja
 * は別のフォールバック（findAnyJapaneseName）で名前だけ拾えてしまうため、「名前は日本語なのに
 * ルールテキストは英語のまま」という中途半端な状態のカードが多数存在する（雷破の執政で発覚）。
 *
 * このスクリプトはfindAnyJapaneseCard（同じフォールバック基準でraw card自体を返す版）を使い、
 * cardsに日本語行が無いオラクルにだけ日本語版プリントを追加する。同一プリントとは限らないため
 * 画像はズレる可能性があるが、ルールテキスト・名前の日本語化を優先する（画像は英語版のままでも
 * 実害は小さい）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-missing-ja-cards.mjs
 */

import { ensureBulkData, loadIndex, findAnyJapaneseCard, toCardRow } from "./lib/scryfallBulk.mjs";

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
  const index = await loadIndex();

  const oracles = await supabaseGet(
    "card_oracles?select=oracle_id,name,printed_name_ja&printed_name_ja=not.is.null&order=oracle_id.asc",
  );
  console.log(`printed_name_jaがあるcard_oracles: ${oracles.length}件`);

  const existingJaOracleIds = new Set(
    (await supabaseGet("cards?select=oracle_id&lang=eq.ja&order=oracle_id.asc")).map((r) => r.oracle_id),
  );
  console.log(`既にcardsに日本語行があるオラクル: ${existingJaOracleIds.size}件`);

  const missingOracles = oracles.filter((o) => !existingJaOracleIds.has(o.oracle_id));
  console.log(`日本語名はあるがcardsに日本語行が無いオラクル: ${missingOracles.length}件`);

  const newRows = [];
  let notFound = 0;
  for (const oracle of missingOracles) {
    const jaCard = findAnyJapaneseCard(index, oracle.oracle_id);
    if (!jaCard) {
      notFound++;
      continue;
    }
    newRows.push(toCardRow(jaCard, oracle.oracle_id));
  }
  console.log(`バルクデータから日本語版プリントを解決: ${newRows.length}件（見つからず: ${notFound}件）`);

  await supabaseUpsert("cards", newRows, "scryfall_id");
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
