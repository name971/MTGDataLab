/** Frankfurter API（為替レート、APIキー不要）から USD/EUR → JPY レートを取得する */

import { supabase } from "./supabase";

export interface ExchangeRates {
  usdToJpy: number;
  eurToJpy: number;
}

/** 為替レートは1日1回しか更新されないため、1時間キャッシュしてFrankfurterへの過剰なリクエストを避ける */
const FX_FETCH_OPTIONS = { next: { revalidate: 3600 } };

export async function fetchExchangeRates(): Promise<ExchangeRates> {
  const res = await fetch(
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY,EUR",
    FX_FETCH_OPTIONS,
  );
  const data = (await res.json()) as { rates: { JPY: number } };
  const usdToJpy: number = data.rates.JPY;
  const eurToJpyRes = await fetch(
    "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=JPY",
    FX_FETCH_OPTIONS,
  );
  const eurData = (await eurToJpyRes.json()) as { rates: { JPY: number } };
  return { usdToJpy, eurToJpy: eurData.rates.JPY };
}

/**
 * exchange_rates（Supabase、日次でml/fetch_data.pyが参照している同じテーブル）から
 * 指定日以前で一番新しい為替レートを取得する。過去の日付（予測日等）のJPY価格を
 * USD換算する際、今日のレートで割り戻すと日々のレート変動分だけ実際の予測時点の
 * 価格とズレて見えてしまうため（2026-09-17、ユーザー指摘）、その日付時点のレートを使う。
 * 土日は為替レートが更新されないため、以前の平日分がそのまま入っている想定
 * （直近の実データで確認済み）。該当データが無い場合はnullを返す。
 */
export async function fetchExchangeRateForDate(date: string): Promise<number | null> {
  const { data } = await supabase
    .from("exchange_rates")
    .select("usd_to_jpy")
    .lte("date", date)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number(data.usd_to_jpy) : null;
}

/** 為替換算した円価格。キリのいい数字に丸めない（誠実さを優先） */
export function toJpy(amountUsd: number, usdToJpy: number): number {
  return amountUsd * usdToJpy;
}

export function formatJpy(jpy: number): string {
  return `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}

/**
 * ロケールに応じて円/ドル表示を切り替える。英語版はUSD表示（米国市場向け方針、2026-09-16）。
 * DBに保存されているのは基本的にjpy_est（記録日時点のレートで換算済み）のみのため、USD表示は
 * 現在の為替レートで逆算する簡易換算（過去の日付の値も同じ現在レートで割り戻すため、
 * 会計目的の厳密さは持たないが、UI表示としては十分）。
 */
export function formatPrice(jpy: number, locale: "ja" | "en", usdToJpyRate: number): string {
  if (locale === "ja") return formatJpy(jpy);
  const rate = usdToJpyRate > 0 ? usdToJpyRate : 150;
  return `$${(jpy / rate).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
