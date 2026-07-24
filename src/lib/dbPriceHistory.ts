import { supabase } from "./supabase";

export interface PricePoint {
  date: string; // YYYY-MM-DD
  jpy: number;
}

/**
 * card_price_snapshots（日次バッチで蓄積、db/schema.sql）から、指定カード・系列(en/ja)の
 * 価格推移を日付昇順で返す。jpy_estがnullの日（価格が取れなかった日）は除外する。
 * 週次/月次ロールアップ（card_price_snapshots_weekly/monthly）はまだ日次バッチが
 * 稼働し始めたばかりでロールアップ対象になる古いデータが無いため、今は日次データのみ使う。
 */
export async function getPriceHistoryForCard(
  oracleId: string,
  series: "en" | "ja",
): Promise<PricePoint[]> {
  const { data, error } = await supabase
    .from("card_price_snapshots")
    .select("date, jpy_est")
    .eq("oracle_id", oracleId)
    .eq("series", series)
    .order("date", { ascending: true });
  if (error || !data) return [];

  return data
    .filter((row): row is { date: string; jpy_est: number } => row.jpy_est !== null)
    .map((row) => ({ date: row.date, jpy: Number(row.jpy_est) }));
}
