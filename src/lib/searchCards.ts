import { supabase } from "./supabase";

/** 2〜3文字未満はクエリを発火させない（db/search-design.sql の運用メモ） */
const MIN_QUERY_LENGTH = 2;

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
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const { data: oracles, error } = await supabase.rpc("search_cards", { query: trimmed });
  if (error || !oracles || oracles.length === 0) return [];

  const oracleIds = oracles.map((o: { oracle_id: string }) => o.oracle_id);
  const { data: cards } = await supabase
    .from("cards")
    .select("oracle_id, lang, image_uri_art_crop")
    .in("oracle_id", oracleIds);

  const imageByOracleId = new Map<string, string>();
  for (const card of cards ?? []) {
    // 日本語版があればそちらの画像を優先（既存の表示ルールに合わせる）
    if (card.image_uri_art_crop && (card.lang === "ja" || !imageByOracleId.has(card.oracle_id))) {
      imageByOracleId.set(card.oracle_id, card.image_uri_art_crop);
    }
  }

  return oracles.map((o: { oracle_id: string; name: string; printed_name_ja: string | null }) => ({
    oracleId: o.oracle_id,
    nameEn: o.name,
    nameJa: o.printed_name_ja,
    artCropUrl: imageByOracleId.get(o.oracle_id) ?? null,
  }));
}
