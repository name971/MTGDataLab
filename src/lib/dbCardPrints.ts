import { supabase } from "./supabase";

export interface CardPrint {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string | null;
  imageUrl: string | null;
}

/**
 * card_prints（scripts/rebuild-card-prints.mjsがScryfallバルクデータから事前生成、db/schema.sql参照）
 * からカード詳細ページ「その他のプリント」欄用の一覧を取得する。ライブAPI呼び出しはしない。
 */
export async function getOtherPrintsForCard(
  oracleId: string,
  excludePrint?: { setCode: string; collectorNumber: string },
): Promise<CardPrint[]> {
  const { data, error } = await supabase
    .from("card_prints")
    .select("scryfall_id, set_code, set_name, collector_number, released_at, image_uri_normal")
    .eq("oracle_id", oracleId)
    .order("released_at", { ascending: false });
  if (error || !data) return [];

  return data
    .filter(
      (p) =>
        !excludePrint || p.set_code !== excludePrint.setCode || p.collector_number !== excludePrint.collectorNumber,
    )
    .map((p) => ({
      scryfallId: p.scryfall_id,
      setCode: p.set_code,
      setName: p.set_name,
      collectorNumber: p.collector_number,
      releasedAt: p.released_at,
      imageUrl: p.image_uri_normal,
    }));
}
