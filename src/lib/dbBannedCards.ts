import { supabase } from "./supabase";
import { getEarliestCardImages, getEarliestPrintSets } from "./dbCardPrints";
import { getCatalogOraclesByNames } from "./catalogDb";
import { BANNED_CARDS, type BannedCardEntry } from "./bannedCards";
import { formatSlug, type Format } from "./formats";
import { colorsFromManaCost } from "./manaColors";

export interface BannedCardWithCard extends Omit<BannedCardEntry, "imageUrl"> {
  oracleId: string;
  nameJa: string | null;
  imageUrl: string | null;
}

/**
 * 指定フォーマットの歴代禁止カードを、年ごとにグループ化して返す。
 * カード名からoracle_idを解決できなかったエントリ（DBの図鑑未反映等）は読み飛ばす。
 * カード画像は当時の雰囲気を出すため、最新プリントではなく初版（英語版）の画像を使う。
 *
 * @param sortDir "desc"（新しい年が先頭、デフォルト）| "asc"（古い年が先頭）
 * @param fillGaps trueの場合、収録データの最小〜最大年の間で禁止が無かった年も
 *   空のcards配列を持つ行として補完する（「禁止が無かった年」を空白行として強調したい用途）
 */
export async function getBannedCardsByYear(
  format: Format,
  { sortDir = "desc", fillGaps = false }: { sortDir?: "asc" | "desc"; fillGaps?: boolean } = {},
): Promise<{ year: number; cards: BannedCardWithCard[] }[]> {
  const entries = BANNED_CARDS.filter((e) => e.format === format);
  if (entries.length === 0) return [];

  const names = [...new Set(entries.map((e) => e.name))];
  const { data: oracles } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja")
    .in("name", names);
  const oracleByName = new Map((oracles ?? []).map((o) => [o.name, o]));

  // デッキ未使用のためPostgresから削除され、D1（カタログ専用）に移ったカードのフォールバック
  const missingNames = names.filter((n) => !oracleByName.has(n));
  if (missingNames.length > 0) {
    const catalogOracles = await getCatalogOraclesByNames(missingNames);
    for (const [name, row] of catalogOracles) {
      oracleByName.set(name, { oracle_id: row.oracle_id, name: row.name, printed_name_ja: row.printed_name_ja });
    }
  }

  const oracleIds = [...oracleByName.values()].map((o) => o.oracle_id);
  const imageByOracle = await getEarliestCardImages(oracleIds);

  const cards: BannedCardWithCard[] = [];
  for (const entry of entries) {
    const oracle = oracleByName.get(entry.name);
    if (!oracle) continue;
    cards.push({
      ...entry,
      oracleId: oracle.oracle_id,
      nameJa: oracle.printed_name_ja,
      imageUrl: entry.imageUrl ?? imageByOracle.get(oracle.oracle_id)?.imageUrl ?? null,
    });
  }

  const byYear = new Map<number, BannedCardWithCard[]>();
  for (const card of cards) {
    if (!byYear.has(card.year)) byYear.set(card.year, []);
    byYear.get(card.year)!.push(card);
  }

  if (fillGaps) {
    const years = [...byYear.keys()];
    for (let y = Math.min(...years); y <= Math.max(...years); y++) {
      if (!byYear.has(y)) byYear.set(y, []);
    }
  }

  const rows = [...byYear.entries()].map(([year, cards]) => ({ year, cards }));
  rows.sort((a, b) => (sortDir === "asc" ? a.year - b.year : b.year - a.year));
  return rows;
}

export interface CurrentBannedCard {
  oracleId: string;
  nameJa: string | null;
  name: string;
  imageUrl: string | null;
  status: "banned" | "restricted";
  releasedAt: string | null;
  colors: string[];
}

/**
 * 「禁止カード」タブ用。歴代禁止カード（bannedCards.ts、手動更新のリスト）と違い、
 * こちらはScryfall由来のcards.legalities（日次バッチで更新される最新の合法性）を
 * そのまま見るため、後年に禁止解除されたカードは自動的に消える（歴代側は解除されても
 * 「その年に禁止された」という記録として残り続ける、という役割分担）。
 */
export async function getCurrentlyBannedCards(format: Format): Promise<CurrentBannedCard[]> {
  const key = formatSlug(format);
  const { data, error } = await supabase
    .from("cards")
    .select(
      "oracle_id, name, legalities, released_at, image_uri_normal, type_line, mana_cost, card_oracles(printed_name_ja)",
    )
    .eq("lang", "en")
    .or(`legalities->>${key}.eq.banned,legalities->>${key}.eq.restricted`);
  // 2026-09-15: 以前はerrorを見ておらず、Supabaseの一時的な失敗が「該当カード0件」と
  // 区別できなかった。このページはrevalidate=21600（6時間）のISRキャッシュのため、
  // 一度の失敗が数時間「Standardに禁止カードがありません」という誤表示のまま焼き付いていた
  // （ユーザー指摘「スタンダードのところが表示されないときある」）。例外を投げて
  // ISR再生成を失敗させ、直前の正常なキャッシュを保持させる。
  if (error) throw new Error(`getCurrentlyBannedCards: cards取得失敗: ${error.message}`);

  const byOracle = new Map<string, CurrentBannedCard>();
  for (const row of data ?? []) {
    if (byOracle.has(row.oracle_id)) continue; // 同じオラクルの複数プリントは1件にまとめる
    // 計略（Conspiracy）は通常のデッキに入れるカードではなくドラフト時の効果のみを持つ
    // 特殊カードで、全フォーマットのlegalitiesが軒並みnot_legal/banned扱いになるため
    // 混ぜるとノイズになる。除外する。
    if (row.type_line?.includes("Conspiracy")) continue;
    const legalities = row.legalities as Record<string, string> | null;
    const status = legalities?.[key] === "restricted" ? "restricted" : "banned";
    byOracle.set(row.oracle_id, {
      oracleId: row.oracle_id,
      // Supabase-jsの型はFK先を配列で推論するが実際は1件（多対1）
      nameJa: (row.card_oracles as unknown as { printed_name_ja: string | null } | null)?.printed_name_ja ?? null,
      name: row.name,
      imageUrl: null,
      status,
      releasedAt: row.released_at,
      colors: colorsFromManaCost(row.mana_cost),
    });
  }

  const oracleIds = [...byOracle.keys()];
  // 初版（英語版）の画像を使う。"Name Sticker" Goblin等、Scryfallバルクデータ上は
  // 紙のプリントが存在せずMTGO専用（デジタル限定の再現版）でしか存在しないカードは
  // rebuild-card-prints.mjsがdigital=trueのプリントを除外するためcard_printsに1件も
  // 入らない＝getEarliestCardImagesで画像が決まらない。この種のカードは値段も付かず
  // 実質「紙のカードとしては存在しない」ノイズなので、一覧から丸ごと除外する。
  const earliestByOracle = await getEarliestCardImages(oracleIds);
  for (const [oracleId, card] of byOracle) {
    const earliest = earliestByOracle.get(oracleId);
    if (!earliest) {
      byOracle.delete(oracleId);
      continue;
    }
    card.imageUrl = earliest.imageUrl;
    if (earliest.releasedAt) card.releasedAt = earliest.releasedAt;
  }

  return [...byOracle.values()].sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
}

export interface ReservedListCard {
  oracleId: string;
  nameJa: string | null;
  name: string;
  imageUrl: string | null;
  colors: string[];
  setCode: string;
  setName: string;
  releasedAt: string | null;
}

const ORACLE_ID_CHUNK = 150; // .in()にUUIDを大量に並べるとURLが長すぎてSupabase/undici側でエラーになるため分割

/** 「再録禁止カード」タブ用。card_oracles.is_reservedはimport-deck-cards.mjs等が
 * Scryfallバルクデータの各プリントから拾って埋めている（1プリントでもreserved=trueなら
 * そのオラクルはリザーブドリスト対象、db/schema.sql参照）。セット（初出セット）ごとに
 * グループ分けして表示する（発売日昇順）。 */
export async function getReservedListCards(): Promise<ReservedListCard[]> {
  const { data: oracles } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja")
    .eq("is_reserved", true);
  if (!oracles || oracles.length === 0) return [];

  const oracleIds = oracles.map((o) => o.oracle_id);
  const manaCostRows: { oracle_id: string; mana_cost: string | null }[] = [];
  for (let i = 0; i < oracleIds.length; i += ORACLE_ID_CHUNK) {
    const chunk = oracleIds.slice(i, i + ORACLE_ID_CHUNK);
    const { data } = await supabase.from("cards").select("oracle_id, mana_cost").eq("lang", "en").in("oracle_id", chunk);
    if (data) manaCostRows.push(...data);
  }
  const [imageByOracle, setByOracle] = await Promise.all([
    getEarliestCardImages(oracleIds),
    getEarliestPrintSets(oracleIds),
  ]);
  const manaCostByOracle = new Map(manaCostRows.map((r) => [r.oracle_id, r.mana_cost]));

  return oracles
    .map((o) => {
      const set = setByOracle.get(o.oracle_id);
      return {
        oracleId: o.oracle_id,
        nameJa: o.printed_name_ja,
        name: o.name,
        imageUrl: imageByOracle.get(o.oracle_id)?.imageUrl ?? null,
        colors: colorsFromManaCost(manaCostByOracle.get(o.oracle_id)),
        setCode: set?.setCode ?? "",
        setName: set?.setName ?? "不明",
        releasedAt: set?.releasedAt ?? null,
      } satisfies ReservedListCard;
    })
    .sort((a, b) => (a.releasedAt ?? "9999").localeCompare(b.releasedAt ?? "9999") || a.name.localeCompare(b.name));
}
