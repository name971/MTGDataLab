import { supabase } from "./supabase";
import { getBestCardImages } from "./dbCardPrints";
import { BANNED_CARDS, type BannedCardEntry } from "./bannedCards";
import type { Format } from "./formats";

export interface BannedCardWithCard extends BannedCardEntry {
  oracleId: string;
  nameJa: string | null;
  imageUrl: string | null;
}

/**
 * 指定フォーマットの歴代禁止カードを、年ごとにグループ化して返す（新しい年が先頭）。
 * カード名からoracle_idを解決できなかったエントリ（DBの図鑑未反映等）は読み飛ばす。
 */
export async function getBannedCardsByYear(
  format: Format,
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
  const imageByOracle = await getBestCardImages(oracleIds);

  const cards: BannedCardWithCard[] = [];
  for (const entry of entries) {
    const oracle = oracleByName.get(entry.name);
    if (!oracle) continue;
    cards.push({
      ...entry,
      oracleId: oracle.oracle_id,
      nameJa: oracle.printed_name_ja,
      imageUrl: imageByOracle.get(oracle.oracle_id) ?? null,
    });
  }

  const byYear = new Map<number, BannedCardWithCard[]>();
  for (const card of cards) {
    if (!byYear.has(card.year)) byYear.set(card.year, []);
    byYear.get(card.year)!.push(card);
  }

  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, cards]) => ({ year, cards }));
}
