/** Frankfurter API（為替レート、APIキー不要）から USD/EUR → JPY レートを取得する */

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

/** 為替換算した円価格。キリのいい数字に丸めない（誠実さを優先） */
export function toJpy(amountUsd: number, usdToJpy: number): number {
  return amountUsd * usdToJpy;
}

export function formatJpy(jpy: number): string {
  return `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}
