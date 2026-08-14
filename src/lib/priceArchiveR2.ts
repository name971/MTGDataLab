/**
 * デッキ未使用カードを含む全カードの長期価格履歴（R2、月次Parquet、
 * ml/fetch_tcgcsv_history.py参照）。D1（price_history_archive/print_price_history_archive）は
 * 直近の実データのみを持つため、それより前の期間やD1が未対応の期間（デッキ未使用カードの
 * プリント単位価格）はこちらから読む。
 *
 * D1と違い「行数」でなく「リクエスト回数」課金のR2に、全カード×2024-02〜の履歴を月次
 * Parquetファイルとして保存してある。読み取りにはhyparquet（純JS実装、Cloudflare Workers
 * ランタイムで動く）を使う。
 */

import { parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet";

const R2_PRICE_PREFIX = "price-history"; // (oracle_id, date, jpy_est)
const R2_PRINT_PRICE_PREFIX = "print-price-history"; // (scryfall_id, date, usd)
// ml/fetch_tcgcsv_history.pyのREAL_ARCHIVE_START_DATEと同じ（これ以降はD1の実データを見る）
const ARCHIVE_MONTHS_START = "2024-02";

async function getR2Bucket() {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return (env as unknown as Env).PRICE_ARCHIVE_R2 ?? null;
  } catch {
    return null;
  }
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ARCHIVE_MONTHS_STARTから今日までの"YYYY-MM"一覧を古い順に返す */
function monthsUpToToday(): string[] {
  const months: string[] = [];
  const [startYear, startMonth] = ARCHIVE_MONTHS_START.split("-").map(Number);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const now = new Date();
  while (cursor <= now) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function readMonthFile<T extends Record<string, unknown>>(
  bucket: R2Bucket,
  prefix: string,
  month: string,
  filter?: { column: string; value: string },
): Promise<T[]> {
  try {
    const obj = await bucket.get(`${prefix}/${month}.parquet`);
    if (!obj) return [];
    const buf = await obj.arrayBuffer();
    const file: AsyncBuffer = {
      byteLength: buf.byteLength,
      slice: (start: number, end?: number) => buf.slice(start, end),
    };
    const rows = await parquetReadObjects({
      file,
      rowFormat: "object",
      ...(filter ? { filter: { [filter.column]: { $eq: filter.value } } } : {}),
    });
    return rows as T[];
  } catch {
    // 月次ファイルが無い・壊れている等は「その月のデータ無し」として扱う
    return [];
  }
}

export interface R2PricePoint {
  date: string;
  usd: number;
}

/**
 * 1プリント（scryfall_id）の全期間USD価格推移を取得する。全月ファイルを並列取得するため、
 * カード詳細ページ（デッキ未使用カードの個別プリント価格グラフ用）でのみ使う想定。
 */
export async function getR2PrintPriceHistory(scryfallId: string): Promise<R2PricePoint[]> {
  const bucket = await getR2Bucket();
  if (!bucket) return [];

  const months = monthsUpToToday();
  const perMonth = await Promise.all(
    months.map((month) =>
      readMonthFile<{ scryfall_id: string; date: string; usd: number }>(
        bucket,
        R2_PRINT_PRICE_PREFIX,
        month,
        { column: "scryfall_id", value: scryfallId },
      ),
    ),
  );
  return perMonth
    .flat()
    .map((r) => ({ date: r.date, usd: Number(r.usd) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 複数プリントの「直近で分かっている価格」だけを取得する（一覧表示用）。全月ではなく
 * 直近の数ヶ月分だけを見れば十分なため、月ファイル数を絞ってリクエスト数を抑える。
 */
export async function getR2LatestPricesForPrints(
  scryfallIds: string[],
  lookbackMonths = 3,
): Promise<Map<string, { date: string; usd: number }>> {
  const result = new Map<string, { date: string; usd: number }>();
  if (scryfallIds.length === 0) return result;

  const bucket = await getR2Bucket();
  if (!bucket) return result;

  const idSet = new Set(scryfallIds);
  const months = monthsUpToToday().slice(-lookbackMonths);
  const perMonth = await Promise.all(
    months.map((month) =>
      readMonthFile<{ scryfall_id: string; date: string; usd: number }>(bucket, R2_PRINT_PRICE_PREFIX, month),
    ),
  );
  for (const rows of perMonth) {
    for (const r of rows) {
      if (!idSet.has(r.scryfall_id)) continue;
      const current = result.get(r.scryfall_id);
      if (!current || r.date > current.date) result.set(r.scryfall_id, { date: r.date, usd: Number(r.usd) });
    }
  }
  return result;
}
