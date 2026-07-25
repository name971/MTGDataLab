import { supabase } from "./supabase";

export interface CardPrint {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string | null;
  imageUrl: string | null;
}

interface CardPrintRow {
  scryfall_id: string;
  set_code: string;
  sets: { set_name: string } | null;
  collector_number: string;
  released_at: string | null;
  image_uri_normal: string | null;
}

function toCardPrint(p: CardPrintRow): CardPrint {
  return {
    scryfallId: p.scryfall_id,
    setCode: p.set_code,
    setName: p.sets?.set_name ?? p.set_code,
    collectorNumber: p.collector_number,
    releasedAt: p.released_at,
    imageUrl: p.image_uri_normal,
  };
}

/**
 * card_prints（scripts/rebuild-card-prints.mjsがScryfallバルクデータから事前生成、db/schema.sql参照）
 * からカード詳細ページ「その他のプリント」欄用の一覧を取得する。ライブAPI呼び出しはしない。
 * set_nameは正規化されたsetsテーブルから結合して取得する（容量削減、db/schema.sql参照）。
 */
export async function getOtherPrintsForCard(
  oracleId: string,
  excludePrint?: { setCode: string; collectorNumber: string },
): Promise<CardPrint[]> {
  const { data, error } = await supabase
    .from("card_prints")
    .select("scryfall_id, set_code, sets(set_name), collector_number, released_at, image_uri_normal")
    .eq("oracle_id", oracleId)
    .order("released_at", { ascending: false })
    .returns<CardPrintRow[]>();
  if (error || !data) return [];

  return data
    .filter(
      (p) =>
        !excludePrint || p.set_code !== excludePrint.setCode || p.collector_number !== excludePrint.collectorNumber,
    )
    .map(toCardPrint);
}

/** プリント別詳細ページ（/cards/[oracleId]/prints/[scryfallId]）用に1件だけ取得する */
export async function getCardPrintByScryfallId(scryfallId: string): Promise<CardPrint | null> {
  const { data, error } = await supabase
    .from("card_prints")
    .select("scryfall_id, set_code, sets(set_name), collector_number, released_at, image_uri_normal")
    .eq("scryfall_id", scryfallId)
    .maybeSingle()
    .returns<CardPrintRow>();
  if (error || !data) return null;

  return toCardPrint(data);
}
