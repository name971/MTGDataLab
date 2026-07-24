import { getOracleIdsByNames, getJpyPricesByOracleIds, getUsageRatesByOracleIds } from "./cardData";

interface HasNameAndPrice {
  nameEn: string;
  priceJpy: number;
}

interface HasNameAndUsageRate {
  nameEn: string;
  usageRatePct: number;
}

/**
 * priceChangePct/usageRatePct（トップページ・ランキング表用）は履歴・トーナメントデータが
 * 無いためダミーのままだが、priceJpyだけはインポート済み（scripts/import-sample-cards.mjs）
 * かつスナップショット済み（scripts/snapshot-prices.mjs）のカードについてDBの実データに差し替える。
 * DBに無いカードは元のサンプル価格のままにする。RankingRow/TrendingCardDataどちらにも使える。
 */
export async function applyDbPrices<T extends HasNameAndPrice>(rows: T[]): Promise<T[]> {
  const names = rows.map((r) => r.nameEn);
  const oracleIdByName = await getOracleIdsByNames(names);
  const oracleIds = [...oracleIdByName.values()];
  const jpyByOracleId = await getJpyPricesByOracleIds(oracleIds);

  return rows.map((row) => {
    const oracleId = oracleIdByName.get(row.nameEn);
    const dbPrice = oracleId ? jpyByOracleId.get(oracleId) : undefined;
    return dbPrice !== undefined ? { ...row, priceJpy: dbPrice } : row;
  });
}

/**
 * usageRatePct（採用率）をcard_usage_statsの実データに差し替える。formatスコープが必要な点が
 * priceJpyと異なる（同じカードでもフォーマットごとに採用率が違うため）。
 * DBに無いカード・そのフォーマットで未集計のカードは元のサンプル値のままにする。
 */
export async function applyDbUsageRates<T extends HasNameAndUsageRate>(
  rows: T[],
  format: string,
): Promise<T[]> {
  const names = rows.map((r) => r.nameEn);
  const oracleIdByName = await getOracleIdsByNames(names);
  const oracleIds = [...oracleIdByName.values()];
  const usageByOracleId = await getUsageRatesByOracleIds(format, oracleIds);

  return rows.map((row) => {
    const oracleId = oracleIdByName.get(row.nameEn);
    const dbUsage = oracleId ? usageByOracleId.get(oracleId) : undefined;
    return dbUsage !== undefined ? { ...row, usageRatePct: dbUsage } : row;
  });
}
