export interface PricePoint {
  date: string; // YYYY-MM-DD
  jpy: number;
  /** その日最安だった印刷のセットコード・セット名（全プリント横断の最安値系列のみ。src/lib/dbCheapestPrice.ts参照） */
  setCode?: string;
  setName?: string;
}
