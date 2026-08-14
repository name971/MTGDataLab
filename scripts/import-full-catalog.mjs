/**
 * card_oracles / cards / card_prints を、デッキ実データ由来のカードだけでなく
 * Scryfallの全カードカタログ（英語・非デジタル）を対象に拡張する。
 * 目的は単なる閲覧用カード図鑑（採用率・価格履歴等の集計対象ではない）。
 *
 * 既存のimport-deck-cards.mjs / rebuild-representative-prints.mjs / rebuild-card-prints.mjsは
 * 「デッキに実際に使われたカードだけ」を対象にする設計だが、このスクリプトは
 * Scryfallバルクデータを1回ストリーミングして「英語・非デジタルの全oracle」を拾い、
 * 既存の代表プリント選定ロジック（isBetterRepresentative）で1件選びつつ、
 * card_prints用に全プリントも同時に集める。
 *
 * 既に import-deck-cards.mjs 等でcard_oracles/cardsに登録済みのカードは、
 * このスクリプトを実行しても選定基準は同じなので基本的に変わらない
 * （on_conflictで上書きされるだけで実質no-op）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/import-full-catalog.mjs
 */

import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  isBetterRepresentative,
  frontFaceName,
  frontFacePrintedName,
  combinedOracleText,
  toCardRow,
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

// anonロールのstatement_timeoutは3秒。全カタログ規模の投入だと1000件バッチはタイムアウトする。
const PAGE_SIZE = 300;
// cardsはmana_value生成列（関数計算＋インデックス更新）があり他テーブルより重いため、
// さらに小さいバッチにしないと3秒を超える。
const CARDS_PAGE_SIZE = 100;

async function supabaseUpsert(table, rows, conflictColumn) {
  const pageSize = table === "cards" ? CARDS_PAGE_SIZE : PAGE_SIZE;
  for (let i = 0; i < rows.length; i += pageSize) {
    const chunk = rows.slice(i, i + pageSize);
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

  // oracle_id -> 代表英語プリント候補（isBetterRepresentativeで最良の1件に絞りながら更新）
  const bestEnByOracle = new Map();
  // oracle_id -> "set#collectorNumber" -> 日本語プリント（代表版と同一プリントを後で探すため）
  const jaByOracleAndPrint = new Map();
  // oracle_id -> 日本語プリント候補（同一プリントが無い場合の名前フォールバック用、最良の1件）
  const bestJaByOracle = new Map();
  // card_prints用: (oracle_id, set, collector_number)ごとに英語版を優先し、
  // 無ければ日本語版限定プリント（Mystical Archive等）を採用する
  const allPrintsByKey = new Map();
  const setsByCode = new Map();

  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (raw.digital) return;
    if (raw.lang !== "en" && raw.lang !== "ja") return;
    // アートカード(art_series)・トークン(token)・記念グッズ(memorabilia)・ミニゲーム(minigame)は
    // ルールテキストを持つ本物のカードではなく、同名の実カードとは別oracle_idで存在するため、
    // 取り込むと検索・ランキングに「同名の別カード」としてノイズが混入する（例: Brainstormの
    // Art Series版が実カードとは別のcard_oraclesの行として登録されてしまっていた）。
    // funnyだけは除外しない: Unfinity以降は同じset内に普通に使用可能なカードが混在するため。
    if (raw.set_type !== "funny" && NON_TOURNAMENT_SET_TYPES.has(raw.set_type)) return;

    // reversible_card（例: Secret Lair Dropの両面ポスター型ボーナス品）等はトップレベルの
    // oracle_idを持たないため、resolveOracleId()でcard_faces側から補う。ここで解決した値は
    // 「全プリント一覧」（allPrintsByKey→card_prints）にだけ使い、下の代表プリント選定
    // （bestEnByOracle等）は従来通りraw.oracle_idの有無で判定する（この手の特殊プリントを
    // 代表プリントに選びたくないため、意図的に区別する）。
    const resolvedOracleId = resolveOracleId(raw);
    if (!resolvedOracleId) return;

    const printKeyAll = `${resolvedOracleId}|${raw.set}|${raw.collector_number}`;
    const currentPrint = allPrintsByKey.get(printKeyAll);
    if (!(currentPrint && (currentPrint.lang === "en" || raw.lang === "ja"))) {
      allPrintsByKey.set(printKeyAll, raw);
      setsByCode.set(raw.set, raw.set_name);
    }

    if (!raw.oracle_id) return; // 代表プリント選定の対象外（reversible_card等）

    if (raw.lang === "en") {
      const current = bestEnByOracle.get(raw.oracle_id);
      if (isBetterRepresentative(raw, current)) bestEnByOracle.set(raw.oracle_id, raw);
      return;
    }

    // lang === "ja"
    if (!jaByOracleAndPrint.has(raw.oracle_id)) jaByOracleAndPrint.set(raw.oracle_id, new Map());
    const byPrint = jaByOracleAndPrint.get(raw.oracle_id);
    const printKey = `${raw.set}#${raw.collector_number}`;
    if (isBetterRepresentative(raw, byPrint.get(printKey))) byPrint.set(printKey, raw);

    // printed_nameが欠落しているプリント（Scryfall側のデータ欠け）を名前フォールバックの
    // 代表に選んでしまうと、後段でnullが上書きされてしまう（Islandで実際に発生した事故）。
    // 実際に名前を持つプリントの中からのみ選ぶ（scryfallBulk.mjsのfindAnyJapaneseNameと同じ判定）。
    if (frontFacePrintedName(raw)) {
      const bestJa = bestJaByOracle.get(raw.oracle_id);
      if (isBetterRepresentative(raw, bestJa)) bestJaByOracle.set(raw.oracle_id, raw);
    }
  });
  console.log(`バルクデータ走査: ${scanned}件中 対象oracle_id ${bestEnByOracle.size}件`);

  const oracleRows = [];
  const cardRows = [];
  const printRows = [];

  for (const [oracleId, enCard] of bestEnByOracle) {
    const byPrint = jaByOracleAndPrint.get(oracleId);
    const printKey = `${enCard.set}#${enCard.collector_number}`;
    const jaCard = byPrint?.get(printKey) ?? null;
    const printedNameJa = jaCard
      ? frontFacePrintedName(jaCard)
      : bestJaByOracle.has(oracleId)
        ? frontFacePrintedName(bestJaByOracle.get(oracleId))
        : null;

    oracleRows.push({
      oracle_id: oracleId,
      name: frontFaceName(enCard),
      printed_name_ja: printedNameJa,
      oracle_text: combinedOracleText(enCard),
      is_reserved: enCard.reserved ?? false,
      is_serialized: enCard.promo_types?.includes("serialized") ?? false,
    });
    cardRows.push(toCardRow(enCard, oracleId));
    if (jaCard) cardRows.push(toCardRow(jaCard, oracleId));
  }

  for (const raw of allPrintsByKey.values()) {
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    printRows.push({
      scryfall_id: raw.id,
      oracle_id: resolveOracleId(raw),
      set_code: raw.set,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
      not_tournament_legal: isNotTournamentLegal(raw),
    });
  }

  const setRows = [...setsByCode.entries()].map(([set_code, set_name]) => ({ set_code, set_name }));

  console.log(
    `card_oracles: ${oracleRows.length}件、cards: ${cardRows.length}件、sets: ${setRows.length}件、card_prints: ${printRows.length}件を保存中...`,
  );
  await supabaseUpsert("card_oracles", oracleRows, "oracle_id");
  await supabaseUpsert("cards", cardRows, "scryfall_id");
  // card_printsがset_codeを外部キー参照しているため、setsを先に投入する
  await supabaseUpsert("sets", setRows, "set_code");
  await supabaseUpsert("card_prints", printRows, "scryfall_id");

  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
