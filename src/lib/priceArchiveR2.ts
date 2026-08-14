/**
 * デッキ未使用カードを含む全カードの長期価格履歴（R2、月次NDJSON.gz、
 * ml/fetch_tcgcsv_history.py参照）。D1（price_history_archive/print_price_history_archive）は
 * 直近の実データのみを持つため、それより前の期間やD1が未対応の期間（デッキ未使用カードの
 * プリント単位価格）はこちらから読む。
 *
 * Parquet+hyparquet（外部ライブラリ）を最初は使っていたが、OpenNextのビルドが全ルートを
 * 1つのWorkerバンドルにまとめる関係で、ライブラリの分だけ無関係なルート（検索等）まで
 * コールドスタートコストが増え、Cloudflare Workers無料プランのCPU時間制限（10ms/リクエスト）
 * を超過させる事故が実際に起きた。gzip圧縮NDJSON（1行1レコードのJSON）+ Workers標準の
 * DecompressionStream（外部ライブラリ不要のWeb API）に変えることでこれを避けている。
 */

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

async function readMonthFile<T>(bucket: R2Bucket, prefix: string, month: string): Promise<T[]> {
  try {
    const obj = await bucket.get(`${prefix}/${month}.ndjson.gz`);
    if (!obj) return [];
    const text = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
    return rows;
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
      readMonthFile<{ scryfall_id: string; date: string; usd: number }>(bucket, R2_PRINT_PRICE_PREFIX, month),
    ),
  );
  return perMonth
    .flat()
    .filter((r) => r.scryfall_id === scryfallId)
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
