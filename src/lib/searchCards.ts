import { supabase } from "./supabase";
import { getBestCardImages } from "./dbCardPrints";
import { meetsMinQueryLength } from "./searchQuery";

export interface SearchCardResult {
  oracleId: string;
  nameEn: string;
  nameJa: string | null;
  artCropUrl: string | null;
}

/**
 * db/search-design.sql の search_cards(query) RPCを呼び出し、
 * ヒットしたoracle_idの代表プリント画像をcardsテーブルから補って返す。
 */
export async function searchCardsInDb(query: string): Promise<SearchCardResult[]> {
  const trimmed = query.trim();
  if (!meetsMinQueryLength(trimmed)) return [];

  const { data: oracles, error } = await supabase.rpc("search_cards", { query: trimmed });
  if (error || !oracles || oracles.length === 0) return [];

  const oracleIds = oracles.map((o: { oracle_id: string }) => o.oracle_id);
  const [{ data: cards }, bestImageByOracle] = await Promise.all([
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop").in("oracle_id", oracleIds),
    getBestCardImages(oracleIds),
  ]);

  // カード詳細ページの「カードデータ」画像選定（安い順+日本語版一致、getBestCardImage）と揃える。
  // card_prints未反映等でgetBestCardImagesが決められなかった場合のみ、cardsテーブルの
  // 代表プリント画像にフォールバックする。
  const imageByOracleId = new Map<string, string>();
  for (const card of cards ?? []) {
    if (card.image_uri_art_crop && (card.lang === "ja" || !imageByOracleId.has(card.oracle_id))) {
      imageByOracleId.set(card.oracle_id, card.image_uri_art_crop);
    }
  }
  for (const [oracleId, normalUrl] of bestImageByOracle) {
    imageByOracleId.set(oracleId, normalUrl.replace("/normal/", "/art_crop/"));
  }

  return oracles.map((o: { oracle_id: string; name: string; printed_name_ja: string | null }) => ({
    oracleId: o.oracle_id,
    nameEn: o.name,
    nameJa: o.printed_name_ja,
    artCropUrl: imageByOracleId.get(o.oracle_id) ?? null,
  }));
}
