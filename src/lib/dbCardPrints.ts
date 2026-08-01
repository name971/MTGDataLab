import { supabase } from "./supabase";

export interface CardPrint {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string | null;
  imageUrl: string | null;
  /** 金縁(World Championship Decks等)・銀縁(Un-set)・memorabilia区分など、
   * オラクルとしては合法でもこの物理プリント自体はどのフォーマットでも使用不可 */
  notTournamentLegal: boolean;
}

interface CardPrintRow {
  scryfall_id: string;
  set_code: string;
  sets: { set_name: string } | null;
  collector_number: string;
  released_at: string | null;
  image_uri_normal: string | null;
  image_uri_normal_ja: string | null;
  not_tournament_legal: boolean;
}

function toCardPrint(p: CardPrintRow): CardPrint {
  return {
    scryfallId: p.scryfall_id,
    setCode: p.set_code,
    setName: p.sets?.set_name ?? p.set_code,
    collectorNumber: p.collector_number,
    releasedAt: p.released_at,
    // 日本語版の画像があればそちらを優先する（無ければ英語版）
    imageUrl: p.image_uri_normal_ja ?? p.image_uri_normal,
    notTournamentLegal: p.not_tournament_legal,
  };
}

const CARD_PRINT_SELECT =
  "scryfall_id, set_code, sets(set_name), collector_number, released_at, image_uri_normal, image_uri_normal_ja, not_tournament_legal";

/**
 * card_prints（scripts/rebuild-card-prints.mjsがScryfallバルクデータから事前生成、db/schema.sql参照）
 * からカード詳細ページ「その他のプリント」欄用の一覧を取得する。ライブAPI呼び出しはしない。
 * set_nameは正規化されたsetsテーブルから結合して取得する（容量削減、db/schema.sql参照）。
 */
export async function getOtherPrintsForCard(
  oracleId: string,
  excludePrint?: { setCode: string; collectorNumber: string },
): Promise<CardPrint[]> {
  // 基本土地等は700件超のプリントを持ち、PostgRESTのデフォルト上限（1000行）に近い/超える
  // ことがある。降順ソートなので今のところ先頭（新しい方）は守られるが、将来的に
  // 1000件を超えるカードが増えることも考え、念のためページングしておく。
  const PAGE_SIZE = 1000;
  const data: CardPrintRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("card_prints")
      .select(CARD_PRINT_SELECT)
      .eq("oracle_id", oracleId)
      .order("released_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<CardPrintRow[]>();
    if (error) return [];
    if (!page || page.length === 0) break;
    data.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

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
    .select(CARD_PRINT_SELECT)
    .eq("scryfall_id", scryfallId)
    .maybeSingle()
    .returns<CardPrintRow>();
  if (error || !data) return null;

  return toCardPrint(data);
}
