/**
 * card_prints（表示専用の「その他のプリント」一覧、db/schema.sql参照）をScryfallバルクデータから
 * 作り直す。cardsテーブルと違い代表プリント1枚に絞らず、oracle_idごとの非デジタルプリントを
 * 全件対象にする。価格は追跡しない（画像・セット名・発売年のみ）。
 *
 * 基本行（scryfall_id・セット名・発売日等）は(セット, コレクター番号)の組ごとに英語版を最優先、
 * 次点で日本語版、それ以外の言語は早い者勝ちで採用する（詳細はmain()内のLANG_PRIORITY参照）。
 * 英語・日本語限定にしていた時期はScryfall本家のプリント数よりかなり少なく表示される問題が
 * あったため、言語を絞らず全言語を対象にした（デジタル専用プリントのみ除外）。
 * 画像だけは別枠でimage_uri_normal_jaに日本語版の画像URLも保持し、表示側（その他のプリント欄・
 * プリント切り替え時のメイン画像）は日本語版があればそちらを使う（バルクデータには元々
 * 日本語版の画像URLも含まれており、追加のAPI呼び出しは不要。画像URL文字列1本の追加なので
 * DB容量への影響も軽微）。
 *
 * loadIndex()（scripts/lib/scryfallBulk.mjs）はメモリ節約のため名前ごとに「一番良い1件」しか
 * 保持しないため、全プリント一覧が必要なこのスクリプトは自前でバルクデータをストリーミングし直す。
 * card_oracles に存在するoracle_idだけを対象にすることでメモリ・DB行数を抑える。
 *
 * 新セット追加時など代表プリントが変わりうるタイミングでのみ再実行すれば十分（日次不要）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/rebuild-card-prints.mjs
 */

import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  NON_TOURNAMENT_SET_TYPES,
  resolveOracleId,
} from "./lib/scryfallBulk.mjs";

// 金縁(World Championship Decks等)は、オラクルとしては合法でもこの物理プリント自体は
// どのフォーマットでも使用不可（Scryfallのlegalitiesには反映されない）。実際に確認したところ
// 金縁の印刷は必ずset_type="memorabilia"（NON_TOURNAMENT_SET_TYPESに含む）なので、border_colorの
// チェックは実質冗長だが、念のため残す。
//
// 注意: Un-set（set_type="funny"）はUnfinity以降、同じセット内に使用可能カードと使用不可カードが
// 混在する（例: Unfinityの"A Good Day to Pie"はborder_color="black"の通常合法カード、
// "Aardwolf's Advantage"はborder_color="black"だが使用不可）。border_colorでは区別できず、
// set_type="funny"で一律に弾くと合法カードまで巻き添えで使用不可扱いにしてしまう誤検知が起きるため、
// Un-set限定でトーナメント不可な印刷にだけ付与されるsecurity_stamp="acorn"で判定する。
function isNotTournamentLegal(raw) {
  if (raw.set_type === "funny") return raw.security_stamp === "acorn";
  return raw.border_color === "gold" || raw.border_color === "silver" || NON_TOURNAMENT_SET_TYPES.has(raw.set_type);
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

  const oracles = await supabaseGet("card_oracles?select=oracle_id&order=oracle_id.asc");
  const knownOracleIds = new Set(oracles.map((o) => o.oracle_id));
  console.log(`対象oracle_id: ${knownOracleIds.size}件`);

  // (oracle_id, set, collector_number)ごとに英語版を最優先、次点で日本語版、それ以外の言語は
  // 早い者勝ちで採用する。同じset+collector_numberを複数言語が共有する場合（多くの通常セットの
  // 翻訳版）は英語版に一本化されるが、Portalの簡体字中国語版やForeign Black Border・スペイン語
  // 限定プロモ等、言語ごとに別のcollector_numberが割り振られているセットはそれぞれ独立した
  // プリントとして残る（元は英語・日本語限定にしていたため、Scryfall本家のプリント数より
  // かなり少なく見える問題があった）。
  const LANG_PRIORITY = { en: 2, ja: 1 };
  const langScore = (lang) => LANG_PRIORITY[lang] ?? 0;

  const byPrintKey = new Map();
  const jaImageByPrintKey = new Map();
  const setsByCode = new Map();
  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (raw.digital) return; // Arena/MTGO専用プリントは対象外（購入・価格追跡の対象にならないため）
    const oracleId = resolveOracleId(raw);
    if (!oracleId || !knownOracleIds.has(oracleId)) return;

    const key = `${oracleId}|${raw.set}|${raw.collector_number}`;

    if (raw.lang === "ja") {
      const face = raw.card_faces?.[0];
      const imageUris = raw.image_uris ?? face?.image_uris ?? null;
      if (imageUris?.normal) jaImageByPrintKey.set(key, imageUris.normal);
    }

    const current = byPrintKey.get(key);
    if (current && langScore(current.lang) >= langScore(raw.lang)) return; // 既存の方が優先度高い/同点なら上書きしない
    byPrintKey.set(key, raw);
    setsByCode.set(raw.set, raw.set_name);
  });

  const prints = [...byPrintKey.values()].map((raw) => {
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    const oracleId = resolveOracleId(raw);
    const key = `${oracleId}|${raw.set}|${raw.collector_number}`;
    return {
      scryfall_id: raw.id,
      oracle_id: oracleId,
      set_code: raw.set,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
      image_uri_normal_ja: jaImageByPrintKey.get(key) ?? null,
      rarity: raw.rarity ?? null,
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
