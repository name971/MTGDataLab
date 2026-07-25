/**
 * card_prints（表示専用の「その他のプリント」一覧、db/schema.sql参照）をScryfallバルクデータから
 * 作り直す。cardsテーブルと違い代表プリント1枚に絞らず、oracle_idごとの非デジタルプリントを
 * 全件対象にする。価格は追跡しない（画像・セット名・発売年のみ）。
 *
 * 基本は英語版のみだが、(セット, コレクター番号)の組に英語版が存在せず日本語版しか無い場合
 * （Mystical Archive等、日本語版限定で別コレクター番号のプリントが存在するケース）は
 * その日本語版を採用する。英語版・日本語版どちらも存在する組は今まで通り英語版だけを使う
 * （単なる言語違いの重複を増やさないため）。
 *
 * loadIndex()（scripts/lib/scryfallBulk.mjs）はメモリ節約のため名前ごとに「一番良い1件」しか
 * 保持しないため、全プリント一覧が必要なこのスクリプトは自前でバルクデータをストリーミングし直す。
 * card_oracles に存在するoracle_idだけを対象にすることでメモリ・DB行数を抑える。
 *
 * 新セット追加時など代表プリントが変わりうるタイミングでのみ再実行すれば十分（日次不要）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/rebuild-card-prints.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE, NON_TOURNAMENT_SET_TYPES } from "./lib/scryfallBulk.mjs";

// 黒/白以外の縁は金縁(World Championship Decks等)・銀縁(Un-set)で、オラクルとしては合法でも
// この物理プリント自体はどのフォーマットでも使用不可（Scryfallのlegalitiesには反映されない）。
function isNotTournamentLegal(raw) {
  return (
    (raw.border_color !== "black" && raw.border_color !== "white" && raw.border_color !== "borderless") ||
    NON_TOURNAMENT_SET_TYPES.has(raw.set_type)
  );
}

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

  // (oracle_id, set, collector_number)ごとに英語版を優先し、無ければ日本語版を採用する
  const byPrintKey = new Map();
  const setsByCode = new Map();
  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if ((raw.lang !== "en" && raw.lang !== "ja") || raw.digital) return;
    if (!raw.oracle_id || !knownOracleIds.has(raw.oracle_id)) return;

    const key = `${raw.oracle_id}|${raw.set}|${raw.collector_number}`;
    const current = byPrintKey.get(key);
    if (current && (current.lang === "en" || raw.lang === "ja")) return; // 英語版があれば日本語版は無視
    byPrintKey.set(key, raw);
    setsByCode.set(raw.set, raw.set_name);
  });

  const prints = [...byPrintKey.values()].map((raw) => {
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    return {
      scryfall_id: raw.id,
      oracle_id: raw.oracle_id,
      set_code: raw.set,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
      not_tournament_legal: isNotTournamentLegal(raw),
    };
  });
  console.log(
    `バルクデータ走査: ${scanned}件中 ${prints.length}件が対象（登録済みカード、英語優先・日本語限定プリント含む）`,
  );

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
