/**
 * cardsテーブルの英語代表プリントのうち、トーナメントで使用できない特殊プロダクト
 * （30th Anniversary Edition等のmemorabilia、トークン、アートカード、Un-set等）が
 * 選ばれてしまっているものを、scripts/lib/scryfallBulk.mjsの新しい選定基準
 * （NON_TOURNAMENT_SET_TYPES除外）で選び直す。
 *
 * fix-representative-prints.mjsとの違い: あちらは「価格が取れていない」カードだけが対象
 * だったが、こちらは価格の有無に関わらず「非トーナメントセットが代表プリントになっている」
 * カード全件が対象（30aは価格が付いていることもあるため、価格の有無では検出できない）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/fix-nontournament-prints.mjs
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
  toCardRow,
  NON_TOURNAMENT_SET_TYPES,
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
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  await ensureBulkData();
  const index = await loadIndex();

  const enCards = await supabaseGet("cards?select=scryfall_id,oracle_id,name,set_code&lang=eq.en");
  console.log(`英語代表プリント: ${enCards.length}件を調査`);

  let fixed = 0;
  let alreadyOk = 0;

  for (const row of enCards) {
    const price = index.priceById.get(row.scryfall_id);
    const isNonTournament = NON_TOURNAMENT_SET_TYPES.has(price?.set_type);

    if (!isNonTournament) {
      alreadyOk++;
      continue;
    }

    const better = findEnglishCard(index, row.name);
    if (!better || better.id === row.scryfall_id) {
      alreadyOk++;
      continue;
    }

    await supabaseDelete(
      `card_price_snapshots?oracle_id=eq.${row.oracle_id}&series=eq.en&scryfall_id=eq.${row.scryfall_id}`,
    );
    await supabaseDelete(`cards?scryfall_id=eq.${row.scryfall_id}`);
    await supabaseUpsert("cards", [toCardRow(better, row.oracle_id)], "scryfall_id");

    console.log(`✓ ${row.name}: ${row.set_code} → ${better.set}`);
    fixed++;
  }

  console.log(`\n完了: ${fixed}件差し替え、${alreadyOk}件はもともとトーナメント対応セット`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
