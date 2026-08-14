import type { PricePoint } from "./dbPriceHistory";
import { supabase } from "./supabase";
import {
  getR2ArchivedPriceHistory,
  getR2PrintPriceHistory,
  getR2RecentPriceHistoryForOracles,
} from "./priceArchiveR2";

/**
 * 価格履歴アーカイブ（Cloudflare R2、カード単位NDJSON.gz、src/lib/priceArchiveR2.ts参照）から
 * オラクル単位の過去価格を取得する。Supabase無料枠対策で、90日より古いcard_cheapest_price_snapshots
 * 相当のデータはこちら（scripts/compute-cheapest-price-snapshots.mjsが日次で書き込む）から取る。
 * 以前はCloudflare D1（price_history_archive）を読んでいたが、D1無料枠の日次読み書き行数上限
 * に達したため、リクエスト数課金のR2へ全面移行した。
 *
 * R2が使えない環境（テスト・ビルド時等）では空配列を返す。アーカイブは補助的なデータなので、
 * ここでのエラーは握りつぶしてよい（呼び出し側src/lib/dbCheapestPrice.ts参照）。
 */
export async function getArchivedPriceHistory(
  oracleId: string,
  finish: "normal" | "foil" = "normal",
): Promise<PricePoint[]> {
  const rows = await getR2ArchivedPriceHistory(oracleId, finish);
  if (rows.length === 0) return [];

  // 各日の最安値がどのセットだったかは、旧アーカイブ分にはNULLしか無いことがある。
  // その場合はセットアイコン無しで表示側がフォールバックする。
  const scryfallIds = [...new Set(rows.map((r) => r.scryfallId).filter((id): id is string => id !== null))];
  const setCodeByScryfallId = new Map<string, string>();
  const setNameByScryfallId = new Map<string, string>();
  if (scryfallIds.length > 0) {
    const { data: printRows } = await supabase
      .from("card_prints")
      .select("scryfall_id, set_code, sets(set_name)")
      .in("scryfall_id", scryfallIds)
      .returns<{ scryfall_id: string; set_code: string; sets: { set_name: string } | null }[]>();
    for (const p of printRows ?? []) {
      setCodeByScryfallId.set(p.scryfall_id, p.set_code);
      setNameByScryfallId.set(p.scryfall_id, p.sets?.set_name ?? p.set_code);
    }
  }

  return rows.map((row) => ({
    date: row.date,
    jpy: row.price,
    setCode: row.scryfallId ? setCodeByScryfallId.get(row.scryfallId) : undefined,
    setName: row.scryfallId ? setNameByScryfallId.get(row.scryfallId) : undefined,
  }));
}

/**
 * 複数オラクル分・指定日以降の価格系列を一括取得する。card_cheapest_price_snapshots
 * （Supabase）は日次の新規書き込みが無くなり常に空のため、カードランキングの価格変化率
 * （src/lib/dbCardRanking.ts）はこちら（R2）を見る必要がある。オラクルごとに並列で
 * GetObjectするため、呼び出し側で並列リクエスト数を適度に抑える意味でoracleIdsを
 * チャンクしてもらう想定（1回あたり50件目安）。
 */
export async function getRecentPriceHistoryForOracles(
  oracleIds: string[],
  sinceDate: string,
): Promise<{ oracleId: string; date: string; jpy: number }[]> {
  return getR2RecentPriceHistoryForOracles(oracleIds, sinceDate);
}

/**
 * プリント単位（scryfall_id単位）の過去USD価格を取得する。個別プリントの価格推移グラフ用
 * （src/lib/dbCardPrintPrices.ts、getPrintPriceHistory）。JPY換算は呼び出し側で行う
 * （日付ごとのexchange_ratesが必要なため）。
 */
export async function getArchivedPrintPriceHistoryUsd(
  scryfallId: string,
  finish: "normal" | "foil" = "normal",
): Promise<{ date: string; usd: number }[]> {
  return getR2PrintPriceHistory(scryfallId, finish);
}
