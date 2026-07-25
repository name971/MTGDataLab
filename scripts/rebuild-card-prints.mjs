/**
 * card_prints（表示専用の「その他のプリント」一覧、db/schema.sql参照）をScryfallバルクデータから
 * 作り直す。cardsテーブルと違い代表プリント1枚に絞らず、oracle_idごとの英語版nonfoil・非デジタル
 * プリントを全件対象にする。価格は追跡しない（画像・セット名・発売年のみ）。
 *
 * loadIndex()（scripts/lib/scryfallBulk.mjs）はメモリ節約のため名前ごとに「一番良い1件」しか
 * 保持しないため、全プリント一覧が必要なこのスクリプトは自前でバルクデータをストリーミングし直す。
 * card_oracles に存在するoracle_idだけを対象にすることでメモリ・DB行数を抑える。
 *
 * 新セット追加時など代表プリントが変わりうるタイミングでのみ再実行すれば十分（日次不要）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/rebuild-card-prints.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE } from "./lib/scryfallBulk.mjs";

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
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  await ensureBulkData();

  const oracles = await supabaseGet("card_oracles?select=oracle_id");
  const knownOracleIds = new Set(oracles.map((o) => o.oracle_id));
  console.log(`対象oracle_id: ${knownOracleIds.size}件`);

  const prints = [];
  const setsByCode = new Map();
  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (raw.lang !== "en" || raw.digital) return;
    if (!raw.oracle_id || !knownOracleIds.has(raw.oracle_id)) return;
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    setsByCode.set(raw.set, raw.set_name);
    prints.push({
      scryfall_id: raw.id,
      oracle_id: raw.oracle_id,
      set_code: raw.set,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
    });
  });
  console.log(`バルクデータ走査: ${scanned}件中 ${prints.length}件が対象（英語・非デジタル・登録済みカード）`);

  // card_printsがset_codeを外部キー参照しているため、setsを先に投入する
  const setRows = [...setsByCode.entries()].map(([set_code, set_name]) => ({ set_code, set_name }));
  await supabaseUpsert("sets", setRows, "set_code");
  await supabaseUpsert("card_prints", prints, "scryfall_id");
  console.log(`\n完了: sets ${setRows.length}件、card_prints ${prints.length}件を保存`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
