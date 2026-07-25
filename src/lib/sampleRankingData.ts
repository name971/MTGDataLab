export interface RankingRow {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  priceJpy: number;
  priceChangePct: number;
  usageRatePct: number;
  /** カードの色（WUBRG順、mana_costから抽出）。色フィルタ用 */
  colors?: string[];
}
