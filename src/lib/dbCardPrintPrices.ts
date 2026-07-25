import { supabase } from "./supabase";
import type { PricePoint } from "./dbPriceHistory";

/**
 * card_print_prices（プリント単位、日付をJSONBに追記していく方式、db/schema.sql参照）から
 * 特定プリントの価格推移を取得する。USDのみ保存されているため、各日付のexchange_ratesで
 * その日時点のレートに変換する（過去の日付にも今日のレートを一律適用すると誤差が出るため）。
 */
export async function getPrintPriceHistory(scryfallId: string): Promise<PricePoint[]> {
  const { data, error } = await supabase
    .from("card_print_prices")
    .select("prices")
    .eq("scryfall_id", scryfallId)
    .maybeSingle();
  if (error || !data?.prices) return [];

  const usdByDate = data.prices as Record<string, number>;
  const dates = Object.keys(usdByDate).sort();
  if (dates.length === 0) return [];

  const { data: rateRows } = await supabase
    .from("exchange_rates")
    .select("date, usd_to_jpy")
    .in("date", dates);
  const rateByDate = new Map<string, number>(
    (rateRows ?? []).map((r) => [r.date, Number(r.usd_to_jpy)]),
  );

  // その日のレートが無い場合（レート取得が失敗した日等）は直近で分かっているレートで代用する
  let lastKnownRate: number | null = null;
  const points: PricePoint[] = [];
  for (const date of dates) {
    const rate: number | null = rateByDate.get(date) ?? lastKnownRate;
    if (rate === null) continue;
    lastKnownRate = rate;
    points.push({ date, jpy: Math.round(usdByDate[date] * rate * 100) / 100 });
  }
  return points;
}

/**
 * 「その他のプリント」一覧のテーブル表示用に、複数プリントの最新価格(JPY)をまとめて取得する。
 * 1件ずつ問い合わせるとN+1になるため、対象プリント分だけ一括取得する。
 */
export async function getLatestPricesForPrints(scryfallIds: string[]): Promise<Map<string, number>> {
  if (scryfallIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("card_print_prices")
    .select("scryfall_id, prices")
    .in("scryfall_id", scryfallIds);
  if (error || !data) return new Map();

  // 全プリントで使われている日付だけ集めて、レートの問い合わせを1回で済ませる
  const latestByPrint = new Map<string, { date: string; usd: number }>();
  const neededDates = new Set<string>();
  for (const row of data) {
    const usdByDate = (row.prices ?? {}) as Record<string, number>;
    const dates = Object.keys(usdByDate).sort();
    const lastDate = dates.at(-1);
    if (!lastDate) continue;
    latestByPrint.set(row.scryfall_id, { date: lastDate, usd: usdByDate[lastDate] });
    neededDates.add(lastDate);
  }
  if (neededDates.size === 0) return new Map();

  const { data: rateRows } = await supabase
    .from("exchange_rates")
    .select("date, usd_to_jpy")
    .in("date", [...neededDates]);
  const rateByDate = new Map<string, number>(
    (rateRows ?? []).map((r) => [r.date, Number(r.usd_to_jpy)]),
  );

  const result = new Map<string, number>();
  for (const [scryfallId, { date, usd }] of latestByPrint) {
    const rate = rateByDate.get(date);
    if (rate === undefined) continue;
    result.set(scryfallId, Math.round(usd * rate * 100) / 100);
  }
  return result;
}
