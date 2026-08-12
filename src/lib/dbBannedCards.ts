import { supabase } from "./supabase";
import { getEarliestCardImages } from "./dbCardPrints";
import { BANNED_CARDS, type BannedCardEntry } from "./bannedCards";
import type { Format } from "./formats";

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
      imageUrl: entry.imageUrl ?? imageByOracle.get(oracle.oracle_id) ?? null,
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
