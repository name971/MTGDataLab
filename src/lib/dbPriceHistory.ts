import { supabase } from "./supabase";

export interface PricePoint {
  date: string; // YYYY-MM-DD
  jpy: number;
  /** その日最安だった印刷のセットコード・セット名（全プリント横断の最安値系列のみ。src/lib/dbCheapestPrice.ts参照） */
  setCode?: string;
  setName?: string;
}

/**
 * card_price_snapshots（日次バッチで蓄積、db/schema.sql）から、指定カード・系列(en/ja)の
 * 価格推移を日付昇順で返す。jpy_estがnullの日（価格が取れなかった日）は除外する。
 * finish="foil"を指定するとjpy_est_foilを見る（foil非対応プリントは常に空配列）。
 * 週次/月次ロールアップ（card_price_snapshots_weekly/monthly）はまだ日次バッチが
 * 稼働し始めたばかりでロールアップ対象になる古いデータが無いため、今は日次データのみ使う。
 */
export async function getPriceHistoryForCard(
  oracleId: string,
  series: "en" | "ja",
  finish: "normal" | "foil" = "normal",
): Promise<PricePoint[]> {
  const priceColumn = finish === "foil" ? "jpy_est_foil" : "jpy_est";
  // 日付フィルタ無しで日次スナップショットの全期間を取る設計だが、PostgRESTのデフォルト
  // 上限（1000行）は日数ベースで無関係に効くため、1枚のカードの蓄積日数が1000日
  // （約2.7年）を超えると昇順ソートの先頭側＝古い日付しか返らず、最新の価格が
  // 静かに欠落する（実際にdbCardUsageByFormat.tsで同種のバグを踏んだ）。ページングする。
  const PAGE_SIZE = 1000;
  const rows: { date: string; price: number | null }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("card_price_snapshots")
      .select(`date, price:${priceColumn}`)
      .eq("oracle_id", oracleId)
      .eq("series", series)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<{ date: string; price: number | null }[]>();
    if (error) return [];
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  return rows
    .filter((row): row is { date: string; price: number } => row.price !== null)
    .map((row) => ({ date: row.date, jpy: Number(row.price) }));
}
