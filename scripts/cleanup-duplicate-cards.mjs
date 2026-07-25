/**
 * cardsテーブルに同一oracle_id+langの代表プリント行が複数残ってしまっているケースを整理する。
 * rebuild-representative-prints.mjs実行中に(削除→挿入)の途中でスクリプトが割り込んだ等の理由で、
 * 古い代表プリント行が消し忘れられて重複することがある。
 * 各(oracle_id, lang)ペアについて、最も新しくupdated_atされた行（＝最新の選定ロジックで
 * 確定した代表プリント）だけを残し、それ以外を削除する（先に外部キーのcard_price_snapshotsを消す）。
 *
 * 1件ずつDELETEすると重複数が多いとき（1万件超）に非常に遅い（実際に数十分〜時間規模になった）ため、
 * 削除対象のscryfall_idをまとめてin.()で一括削除する。
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
const DELETE_CHUNK = 50; // 大きすぎるとcard_price_snapshots側のDELETEがタイムアウトするため小分けにする

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

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function runNext() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
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

  const staleIds = [];
  for (const group of duplicateGroups) {
    group.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    const [, ...stale] = group; // 先頭（最新updated_at）だけ残す
    staleIds.push(...stale.map((r) => r.scryfall_id));
  }
  console.log(`削除対象: ${staleIds.length}件`);

  const chunks = [];
  for (let i = 0; i < staleIds.length; i += DELETE_CHUNK) chunks.push(staleIds.slice(i, i + DELETE_CHUNK));

  let done = 0;
  await runWithConcurrency(chunks, 8, async (chunk) => {
    const idsParam = chunk.join(",");
    await supabaseDelete(`card_price_snapshots?scryfall_id=in.(${idsParam})`);
    await supabaseDelete(`cards?scryfall_id=in.(${idsParam})`);
    done += chunk.length;
    console.log(`  ...${done}/${staleIds.length}件削除済み`);
  });

  console.log(`\n完了: ${staleIds.length}件の重複行を削除`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
