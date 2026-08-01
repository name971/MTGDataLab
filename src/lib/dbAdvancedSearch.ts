import { supabase } from "./supabase";
import { colorsFromManaCost } from "./manaColors";
import { getJpyPricesByOracleIds } from "./cardData";
import type { Format } from "./formats";
import { formatSlug } from "./formats";
import { TYPE_GLOSSARY_JA_TO_EN } from "./typeGlossary";

export interface AdvancedSearchFilters {
  name?: string;
  text?: string;
  type?: string;
  colors?: string[]; // W/U/B/R/Gのサブセット。「これらの色を全て含む」で判定する
  colorlessOnly?: boolean;
  rarities?: string[]; // common/uncommon/rare/mythic
  format?: Format;
  mvMin?: number;
  mvMax?: number;
  priceMin?: number;
  priceMax?: number;
}

export interface AdvancedSearchResult {
  oracleId: string;
  nameEn: string;
  nameJa: string | null;
  imageUrl: string | null;
  typeLine: string | null;
  rarity: string;
  priceJpy: number | null;
}

interface CardRow {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  power: string | null;
  toughness: string | null;
  rarity: string;
  legalities: Record<string, string>;
  image_uri_normal: string | null;
}

const CARD_SELECT = "oracle_id, name, mana_cost, type_line, power, toughness, rarity, legalities, image_uri_normal";

// 候補が多すぎるとフィルタ処理・後続の価格問い合わせが重くなるため、SQL側の絞り込み後の
// 候補数に上限を設ける（色・マナ総量・価格帯はここではなくJS側で判定するため、SQLだけでは
// 絞り切れないことがある）。
const CANDIDATE_CAP = 500;
const DISPLAY_LIMIT = 60;
// .in()にUUIDを一度に大量に並べるとURLが長すぎてPostgRESTが400 Bad Requestを返す
// （dbCardPrintPrices.ts等、他所で実際に踏んだのと同じ問題）。チャンクに分割して問い合わせる。
const ID_CHUNK = 150;
// oracle_text・printed_text_ja等のILIKE検索でヒットするoracle_id候補自体も、ありふれた単語
// （例:「引く」）だとPostgRESTのデフォルト行数上限（1000件）に達することがある。以降どうせ
// CANDIDATE_CAP件しか使わないため、候補集めの上限もそれに合わせて確保しておけば十分。
const ID_LOOKUP_LIMIT = CANDIDATE_CAP * 2;

/** "{2}{W/U}{B}"のようなmana_costからマナ総量を概算する（X等は0扱い、ハイブリッド/Phyrexianは1扱い） */
function manaValueFromCost(manaCost: string | null | undefined): number {
  if (!manaCost) return 0;
  const symbols = [...manaCost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  let total = 0;
  for (const inner of symbols) {
    if (inner === "X" || inner === "Y" || inner === "Z") continue;
    const numeric = Number(inner);
    total += Number.isNaN(numeric) ? 1 : numeric;
  }
  return total;
}

/**
 * タイプ行の検索語（例:「マーフォーク」）に対応する英語のクリーチャー・タイプ等を辞書から探す。
 * 日本語版プリントが1件も無いカード（type_lineが常に英語のまま）でも、この英語訳で
 * type_line.ilikeにヒットさせられる。複数のタイプ名を含む入力（例:「エルフ・戦士」）にも
 * 対応するため、辞書のキーが入力に部分一致するもの全てを集める。
 */
// ルール変更でカード・タイプ名が変わったが、古いプリントのtype_lineには旧名称のまま残っているもの。
// 例: 同族(Kindred)は元々「部族」(Tribal)、インスタント(Instant)は「インターラプト」(Interrupt)を
// 統合した経緯があり、ごく一部の古いカードのtype_lineには今も旧名称が残っている。
const LEGACY_TYPE_ALIASES: Record<string, string[]> = {
  同族: ["Tribal"],
  インスタント: ["Interrupt"],
};

function englishTypeEquivalents(input: string): string[] {
  const matches: string[] = [];
  for (const [ja, en] of Object.entries(TYPE_GLOSSARY_JA_TO_EN)) {
    if (input.includes(ja)) {
      matches.push(en);
      if (LEGACY_TYPE_ALIASES[ja]) matches.push(...LEGACY_TYPE_ALIASES[ja]);
    }
  }
  return matches;
}

function hasAnyFilter(f: AdvancedSearchFilters): boolean {
  return !!(
    f.name?.trim() ||
    f.text?.trim() ||
    f.type?.trim() ||
    (f.colors && f.colors.length > 0) ||
    f.colorlessOnly ||
    (f.rarities && f.rarities.length > 0) ||
    f.format ||
    f.mvMin !== undefined ||
    f.mvMax !== undefined ||
    f.priceMin !== undefined ||
    f.priceMax !== undefined
  );
}

/**
 * Scryfallの高度検索（https://scryfall.com/advanced）を参考にした複合条件検索。
 * SQL側で絞り込める条件（名前・ルールテキスト・タイプ行・レアリティ・フォーマット適正）を
 * 先にDBへ問い合わせて候補を絞り、DBに列を持たない条件（色・マナ総量・価格帯）はJS側で判定する。
 * 条件を1つも指定していない場合は全件スキャンを避けるため空配列を返す。
 */
export async function advancedSearchCards(filters: AdvancedSearchFilters): Promise<AdvancedSearchResult[]> {
  if (!hasAnyFilter(filters)) return [];

  const name = filters.name?.trim();
  const text = filters.text?.trim();
  const type = filters.type?.trim();

  // 日本語名はcard_oraclesにしか無いため、cards.name（英語）とのOR条件用に別途oracle_idを引く
  let jaNameOracleIds: string[] = [];
  if (name) {
    const { data } = await supabase
      .from("card_oracles")
      .select("oracle_id")
      .ilike("printed_name_ja", `%${name}%`)
      .limit(ID_LOOKUP_LIMIT);
    jaNameOracleIds = (data ?? []).map((r) => r.oracle_id);
  }

  // タイプ行の日本語訳（例:「マーフォーク」）はcards（lang='ja'）のprinted_type_lineにしか無いため、
  // 英語のtype_line ilikeとのOR条件用に別途oracle_idを引く
  let jaTypeOracleIds: string[] = [];
  if (type) {
    const { data } = await supabase
      .from("cards")
      .select("oracle_id")
      .eq("lang", "ja")
      .ilike("printed_type_line", `%${type}%`)
      .limit(ID_LOOKUP_LIMIT);
    jaTypeOracleIds = (data ?? []).map((r) => r.oracle_id);
  }
  // 日本語版プリントが1件も無いカードは上のjaTypeOracleIdsで拾えないため、辞書（typeGlossary.ts）で
  // 該当する英語のタイプ名も割り出し、英語のtype_line ilikeに追加する
  const typeEnEquivalents = type ? englishTypeEquivalents(type) : [];

  // ルールテキストは英語がcard_oracles.oracle_text、日本語訳がcards（lang='ja'）のprinted_text_ja
  // に分かれているため、両方でヒットしたoracle_idを合算する。ありふれた単語だと候補が数千件に
  // 及ぶことがあるため、それぞれ上限を設けてから合算する。
  let textOracleIds: string[] | null = null;
  if (text) {
    const [{ data: enTextRows }, { data: jaTextRows }] = await Promise.all([
      supabase.from("card_oracles").select("oracle_id").ilike("oracle_text", `%${text}%`).limit(ID_LOOKUP_LIMIT),
      supabase
        .from("cards")
        .select("oracle_id")
        .eq("lang", "ja")
        .ilike("printed_text_ja", `%${text}%`)
        .limit(ID_LOOKUP_LIMIT),
    ]);
    textOracleIds = [
      ...new Set([...(enTextRows ?? []).map((r) => r.oracle_id), ...(jaTextRows ?? []).map((r) => r.oracle_id)]),
    ];
    if (textOracleIds.length === 0) return []; // ルールテキストに一致するカードが無ければこの時点で確定
  }

  // name/type/rarity/フォーマット適正の絞り込みを、渡されたクエリビルダーに適用する。
  // supabase-jsのビルダーはメソッドチェーンごとに型が変わり汎用的に型付けしづらいためanyで扱う。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyCommonFilters(q: any): any {
    let query = q;
    if (name) {
      query =
        jaNameOracleIds.length > 0
          ? query.or(`name.ilike.%${name}%,oracle_id.in.(${jaNameOracleIds.slice(0, ID_CHUNK).join(",")})`)
          : query.ilike("name", `%${name}%`);
    }
    if (type) {
      const orParts = [`type_line.ilike.%${type}%`];
      if (jaTypeOracleIds.length > 0) orParts.push(`oracle_id.in.(${jaTypeOracleIds.slice(0, ID_CHUNK).join(",")})`);
      for (const en of typeEnEquivalents) orParts.push(`type_line.ilike.%${en}%`);
      query = query.or(orParts.join(","));
    }
    if (filters.rarities && filters.rarities.length > 0) query = query.in("rarity", filters.rarities);
    if (filters.format) query = query.eq(`legalities->>${formatSlug(filters.format)}`, "legal");
    return query;
  }

  let cardRows: CardRow[];
  if (textOracleIds) {
    // textOracleIdsは千件規模のこともあり.in()に一括で渡せないため、チャンク分割して問い合わせる
    const rows: CardRow[] = [];
    for (let i = 0; i < textOracleIds.length && rows.length < CANDIDATE_CAP; i += ID_CHUNK) {
      const chunk = textOracleIds.slice(i, i + ID_CHUNK);
      const q = applyCommonFilters(supabase.from("cards").select(CARD_SELECT).eq("lang", "en").in("oracle_id", chunk));
      const { data } = (await q.limit(CANDIDATE_CAP - rows.length)) as { data: CardRow[] | null };
      if (data) rows.push(...data);
    }
    cardRows = rows;
  } else {
    const q = applyCommonFilters(supabase.from("cards").select(CARD_SELECT).eq("lang", "en"));
    const { data, error } = (await q.limit(CANDIDATE_CAP)) as { data: CardRow[] | null; error: unknown };
    if (error || !data) return [];
    cardRows = data;
  }
  if (cardRows.length === 0) return [];

  // cardsは本来oracle_idごとに代表プリント（lang='en'）1行のはずだが、実データには同じoracle_idの
  // 行が複数残っていることがある（例: 再録のたびに旧セットの行が消えず並存）。検索結果に同じカードが
  // 何度も出るのを防ぐため、oracle_id単位で1件に絞る。
  const seenOracleIds = new Set<string>();
  cardRows = cardRows.filter((c) => {
    if (seenOracleIds.has(c.oracle_id)) return false;
    seenOracleIds.add(c.oracle_id);
    return true;
  });

  // 色・マナ総量はDBに列を持たないため、ここでJS側フィルタする
  let candidates = cardRows;
  if (filters.colorlessOnly) {
    candidates = candidates.filter((c) => colorsFromManaCost(c.mana_cost).length === 0);
  } else if (filters.colors && filters.colors.length > 0) {
    const selected = filters.colors;
    candidates = candidates.filter((c) => {
      const cardColors = colorsFromManaCost(c.mana_cost);
      return selected.every((col) => cardColors.includes(col));
    });
  }
  if (filters.mvMin !== undefined || filters.mvMax !== undefined) {
    candidates = candidates.filter((c) => {
      const mv = manaValueFromCost(c.mana_cost);
      if (filters.mvMin !== undefined && mv < filters.mvMin) return false;
      if (filters.mvMax !== undefined && mv > filters.mvMax) return false;
      return true;
    });
  }
  if (candidates.length === 0) return [];

  // 価格帯フィルタが無い場合でも一覧表示に価格を出したいので、候補全件分まとめて取得する
  const oracleIds = candidates.map((c) => c.oracle_id);
  const priceByOracle = await getJpyPricesByOracleIds(oracleIds);

  let withPrice = candidates.map((c) => ({ card: c, priceJpy: priceByOracle.get(c.oracle_id) ?? null }));
  if (filters.priceMin !== undefined || filters.priceMax !== undefined) {
    withPrice = withPrice.filter(({ priceJpy }) => {
      if (priceJpy === null) return false; // 価格帯指定時は価格不明なカードは対象外にする
      if (filters.priceMin !== undefined && priceJpy < filters.priceMin) return false;
      if (filters.priceMax !== undefined && priceJpy > filters.priceMax) return false;
      return true;
    });
  }
  if (withPrice.length === 0) return [];

  // 価格が高いカードほど有名で見覚えがあることが多いため、価格の高い順をデフォルトにする
  // （価格不明のカードは末尾に回す）
  const sorted = withPrice
    .sort((a, b) => (b.priceJpy ?? -1) - (a.priceJpy ?? -1))
    .slice(0, DISPLAY_LIMIT);

  // 日本語名・日本語版画像は別途まとめて取得する（候補が絞れた後なのでコストは小さい）
  const finalOracleIds = sorted.map((r) => r.card.oracle_id);
  const [{ data: oracles }, { data: jaCards }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, printed_name_ja").in("oracle_id", finalOracleIds),
    supabase
      .from("cards")
      .select("oracle_id, image_uri_normal")
      .eq("lang", "ja")
      .in("oracle_id", finalOracleIds),
  ]);
  const nameJaByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o.printed_name_ja]));
  const jaImageByOracle = new Map((jaCards ?? []).map((c) => [c.oracle_id, c.image_uri_normal]));

  return sorted.map(({ card, priceJpy }) => ({
    oracleId: card.oracle_id,
    nameEn: card.name,
    nameJa: nameJaByOracle.get(card.oracle_id) ?? null,
    imageUrl: jaImageByOracle.get(card.oracle_id) ?? card.image_uri_normal,
    typeLine: card.type_line,
    rarity: card.rarity,
    priceJpy,
  }));
}
