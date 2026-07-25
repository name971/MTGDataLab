/**
 * cardsテーブルに同一oracle_id+langの代表プリント行が複数残ってしまっているケースを整理する。
 * rebuild-representative-prints.mjs実行中に(削除→挿入)の途中でスクリプトが割り込んだ等の理由で、
 * 古い代表プリント行が消し忘れられて重複することがある。
 * 各(oracle_id, lang)ペアについて、最も新しくupdated_atされた行（＝最新の選定ロジックで
 * 確定した代表プリント）だけを残し、それ以外を削除する（先に外部キーのcard_price_snapshotsを消す）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/cleanup-duplicate-cards.mjs
 */

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

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const cards = await supabaseGet("cards?select=scryfall_id,oracle_id,lang,updated_at");
  console.log(`cards: ${cards.length}件`);

  const byKey = new Map();
  for (const c of cards) {
    const key = `${c.oracle_id}|${c.lang}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const duplicateGroups = [...byKey.values()].filter((group) => group.length > 1);
  console.log(`重複グループ: ${duplicateGroups.length}件`);

  let deleted = 0;
  for (const group of duplicateGroups) {
    group.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    const [, ...stale] = group; // 先頭（最新updated_at）だけ残す
    for (const row of stale) {
      await supabaseDelete(
        `card_price_snapshots?oracle_id=eq.${row.oracle_id}&series=eq.${row.lang}&scryfall_id=eq.${row.scryfall_id}`,
      );
      await supabaseDelete(`cards?scryfall_id=eq.${row.scryfall_id}`);
      deleted++;
    }
  }

  console.log(`\n完了: ${deleted}件の重複行を削除`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
