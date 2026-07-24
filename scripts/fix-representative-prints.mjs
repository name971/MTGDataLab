/**
 * 過去（Scryfallのライブfuzzy検索時代）にインポートされたcardsの中には、代表プリントとして
 * デジタル専用セット（Vintage Masters等、MTGOのみで紙の価格が存在しない）が選ばれてしまって
 * いるものがある（例: Underground Sea → vma）。
 *
 * scripts/lib/scryfallBulk.mjsのfindEnglishCard()（非promo・非デジタル優先）で正しい代表
 * プリントを選び直し、現状と違えば cards / card_price_snapshots を差し替える。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/fix-representative-prints.mjs
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
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

  // 英語代表プリントの価格が取れていないカードを対象にする（デジタル専用プリント選定ミスの疑い）
  const today = new Date().toISOString().slice(0, 10);
  const nullPriceSnapshots = await supabaseGet(
    `card_price_snapshots?select=oracle_id,scryfall_id&series=eq.en&jpy_est=is.null&date=eq.${today}`,
  );
  console.log(`価格取得失敗（英語）: ${nullPriceSnapshots.length}件を調査`);

  const oracleRows = await supabaseGet(
    `card_oracles?select=oracle_id,name&oracle_id=in.(${nullPriceSnapshots.map((r) => r.oracle_id).join(",")})`,
  );
  const nameByOracle = new Map(oracleRows.map((r) => [r.oracle_id, r.name]));

  let fixed = 0;
  let unchanged = 0;

  for (const row of nullPriceSnapshots) {
    const name = nameByOracle.get(row.oracle_id);
    if (!name) continue;

    const better = findEnglishCard(index, name);
    if (!better || better.id === row.scryfall_id) {
      unchanged++;
      continue;
    }

    // 差し替え: cards.scryfall_idを外部キー参照しているcard_price_snapshotsを先に消してから、
    // 古いcards行を削除し、新しい代表プリントを追加する
    await supabaseDelete(
      `card_price_snapshots?oracle_id=eq.${row.oracle_id}&series=eq.en&scryfall_id=eq.${row.scryfall_id}`,
    );
    await supabaseDelete(`cards?scryfall_id=eq.${row.scryfall_id}`);
    await supabaseUpsert("cards", [toCardRow(better, row.oracle_id)], "scryfall_id");

    console.log(`✓ ${name}: ${row.scryfall_id} → ${better.id} (${better.set})`);
    fixed++;
  }

  console.log(`\n完了: ${fixed}件差し替え、${unchanged}件は変更なし（バルクデータでも紙の価格が無い等）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
