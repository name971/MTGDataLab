import { supabase } from "./supabase";

export interface PricePoint {
  date: string; // YYYY-MM-DD
  jpy: number;
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
  const { data, error } = await supabase
    .from("card_price_snapshots")
    .select(`date, price:${priceColumn}`)
    .eq("oracle_id", oracleId)
    .eq("series", series)
    .order("date", { ascending: true });
  if (error || !data) return [];

  return (data as unknown as { date: string; price: number | null }[])
    .filter((row): row is { date: string; price: number } => row.price !== null)
    .map((row) => ({ date: row.date, jpy: Number(row.price) }));
}
