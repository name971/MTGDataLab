import { supabase } from "./supabase";
import type { PricePoint } from "./dbPriceHistory";
import { getArchivedPrintPriceHistoryUsd } from "./priceArchiveDb";
import { getR2LatestPricesForPrints } from "./priceArchiveR2";

/**
 * card_print_prices（プリント単位、日付をJSONBに追記していく方式、db/schema.sql参照）から
 * 特定プリントの価格推移を取得する。USDのみ保存されているため、各日付のexchange_ratesで
 * その日時点のレートに変換する（過去の日付にも今日のレートを一律適用すると誤差が出るため）。
 *
 * Supabase無料枠対策で、90日より古い日付キーはR2（カード単位NDJSON.gz、
 * scripts/archive-old-print-prices.mjs）へ移してSupabase側のJSONBからは間引いている。
 * そのため直近（Supabase）とアーカイブ（R2、getArchivedPrintPriceHistoryUsd）の両方から
 * 取得して結合する。R2側はTCGCSVバックフィル（2024-02〜）とデッキ未使用カードの価格も
 * 含むため、Postgresに無いプリントでもこちらだけで全期間表示できる。
 */
export async function getPrintPriceHistory(
  scryfallId: string,
  finish: "normal" | "foil" = "normal",
): Promise<PricePoint[]> {
  const priceColumn = finish === "foil" ? "prices_foil" : "prices";
  const { data, error } = await supabase
    .from("card_print_prices")
    .select(priceColumn)
    .eq("scryfall_id", scryfallId)
    .maybeSingle();
  if (error) return [];

  const recentUsdByDate = data
    ? ((data as unknown as Record<string, Record<string, number>>)[priceColumn] ?? {})
    : {};
  const archived = await getArchivedPrintPriceHistoryUsd(scryfallId, finish);

  const usdByDate: Record<string, number> = {};
  for (const p of archived) usdByDate[p.date] = p.usd;
  Object.assign(usdByDate, recentUsdByDate); // 重複日付はSupabase（直近）側を優先

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
// .in()にUUIDを一度に大量（数百件超）に並べるとURLが長すぎてPostgRESTが400 Bad Requestを返す
// （基本土地のように「その他のプリント」が700件を超えるカードで実際に発生し、価格が全件
// サイレントに空欄になっていた）。チャンクに分割して問い合わせる。
const SCRYFALL_ID_CHUNK = 150;

export interface LatestPrintPrices {
  normal: Map<string, number>;
  foil: Map<string, number>;
}

export async function getLatestPricesForPrints(scryfallIds: string[]): Promise<LatestPrintPrices> {
  if (scryfallIds.length === 0) return { normal: new Map(), foil: new Map() };

  // card_print_current_prices（1プリント1行の「今の価格」キャッシュ、DB容量超過対応で新設）を
  // 見る。以前はcard_print_prices（JSONB全履歴）から最新日付キーを都度探していたが、
  // このキャッシュテーブル自体が既に「各プリントの最新価格」を保持しているため不要になった。
  const chunks: string[][] = [];
  for (let i = 0; i < scryfallIds.length; i += SCRYFALL_ID_CHUNK) {
    chunks.push(scryfallIds.slice(i, i + SCRYFALL_ID_CHUNK));
  }
  // チャンクごとに独立したクエリなので並列実行する（基本土地のように700件超のカードだと
  // 直列では往復回数分そのまま遅くなっていた）。1チャンク失敗しても他のプリントの価格は
  // 表示できるよう、個別のエラーは無視して続行する。
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const { data: page, error } = await supabase
        .from("card_print_current_prices")
        .select("scryfall_id, usd, usd_foil, date")
        .in("scryfall_id", chunk);
      return error ? [] : (page ?? []);
    }),
  );
  const data = pages.flat();
  // 全プリント・通常/Foil双方で使われている日付だけ集めて、レートの問い合わせを1回で済ませる
  const latestNormalByPrint = new Map<string, { date: string; usd: number }>();
  const latestFoilByPrint = new Map<string, { date: string; usd: number }>();
  const neededDates = new Set<string>();
  for (const row of data) {
    if (row.usd != null) {
      latestNormalByPrint.set(row.scryfall_id, { date: row.date, usd: Number(row.usd) });
      neededDates.add(row.date);
    }
    if (row.usd_foil != null) {
      latestFoilByPrint.set(row.scryfall_id, { date: row.date, usd: Number(row.usd_foil) });
      neededDates.add(row.date);
    }
  }

  // デッキ未使用カード等、Postgresに価格が無いプリントはR2（長期履歴、Normal版のみ）で補う。
  // R2側は1件ごとに個別GetObjectするため、カード詳細ページ（数件規模）では有効だが、
  // ランキング/トレンド等「多数のカードの全プリント」をまとめて問い合わせる場面で欠損が
  // 多いと数百件規模のリクエストが発生し、レイテンシが跳ね上がる（実際に発生した）。
  // そのため欠損件数が少ない（＝おそらく1〜数枚のカード詳細ページ相当）場合だけ試す。
  const missingIds = scryfallIds.filter((id) => !latestNormalByPrint.has(id));
  const R2_FALLBACK_MAX_MISSING = 30;
  if (missingIds.length > 0 && missingIds.length <= R2_FALLBACK_MAX_MISSING) {
    const r2Prices = await getR2LatestPricesForPrints(missingIds);
    for (const [scryfallId, { date, usd }] of r2Prices) {
      latestNormalByPrint.set(scryfallId, { date, usd });
      neededDates.add(date);
    }
  }

  if (neededDates.size === 0) return { normal: new Map(), foil: new Map() };

  // 最新日（今日）分のレートがまだ取り込まれていないタイミングがある（為替レート取得と
  // 価格スナップショット取得は別バッチで、後者が先に終わることがあるため）。その日だけ
  // 価格が丸ごと非表示になるのを避けるため、直近の日付のレートが無ければ、それより前で
  // 一番近い日のレートを暫定値として使う。過去に遡ってのlte検索で済むよう、
  // neededDatesの最大値以前を全部まとめて取得しておく。
  const maxNeededDate = [...neededDates].sort().at(-1)!;
  const { data: rateRows } = await supabase
    .from("exchange_rates")
    .select("date, usd_to_jpy")
    .lte("date", maxNeededDate)
    .order("date", { ascending: false });
  const sortedRates = (rateRows ?? []).map((r) => ({ date: r.date, rate: Number(r.usd_to_jpy) }));

  function rateAtOrBefore(date: string): number | undefined {
    return sortedRates.find((r) => r.date <= date)?.rate;
  }

  function toJpyMap(byPrint: Map<string, { date: string; usd: number }>): Map<string, number> {
    const result = new Map<string, number>();
    for (const [scryfallId, { date, usd }] of byPrint) {
      const rate = rateAtOrBefore(date);
      if (rate === undefined) continue;
      result.set(scryfallId, Math.round(usd * rate * 100) / 100);
    }
    return result;
  }

  return { normal: toJpyMap(latestNormalByPrint), foil: toJpyMap(latestFoilByPrint) };
}
