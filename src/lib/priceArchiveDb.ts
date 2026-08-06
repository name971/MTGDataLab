import type { PricePoint } from "./dbPriceHistory";

/**
 * 価格履歴アーカイブ用D1（Cloudflare、jp-mtgstocks-archive、wrangler.jsonc参照）から
 * オラクル単位の過去価格を取得する。Supabase無料枠対策で、90日より古い
 * card_cheapest_price_snapshots（Supabase）はD1側へ移してある
 * （scripts/archive-old-price-snapshots.mjs）。
 *
 * D1が使えない環境（テスト・ビルド時等、getCloudflareContextが例外を投げる場合）では
 * 空配列を返す。D1側にまだ何もアーカイブされていない・接続できない場合でも、
 * 価格推移グラフ自体はSupabase側の直近データだけで問題なく表示できるため、
 * ここでのエラーは握りつぶして良い（呼び出し側src/lib/dbCheapestPrice.ts参照）。
 */
export async function getArchivedPriceHistory(
  oracleId: string,
  finish: "normal" | "foil" = "normal",
): Promise<PricePoint[]> {
  try {
    // 静的解析でCloudflare依存を検出されないよう動的importにする
    // （next buildがCloudflare Workers以外の環境も含めて型解決するため）。
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    // getCloudflareContext()の戻り値の型（CloudflareEnv、@opennextjs/cloudflare側の内部定義）は
    // カスタムバインディング（PRICE_ARCHIVE_DB）を含まないため、wrangler.jsonc/wrangler types
    // で生成したグローバルEnv型（worker-configuration.d.ts）にキャストする。
    const db = (env as unknown as Env).PRICE_ARCHIVE_DB;
    if (!db) return [];

    const column = finish === "foil" ? "jpy_est_foil" : "jpy_est";
    const result = await db
      .prepare(
        `SELECT date, ${column} AS price FROM price_history_archive WHERE oracle_id = ?1 AND ${column} IS NOT NULL ORDER BY date ASC`,
      )
      .bind(oracleId)
      .all<{ date: string; price: number }>();

    return (result.results ?? []).map((row: { date: string; price: number }) => ({
      date: row.date,
      jpy: Number(row.price),
    }));
  } catch {
    // getCloudflareContext()はWorkersランタイム外（一部のビルド・テスト環境）で例外を投げる。
    // アーカイブは補助的なデータなので、失敗しても直近データの表示は妨げない。
    return [];
  }
}

/**
 * print_price_history_archive（scripts/archive-old-print-prices.mjs）から、特定プリント
 * （scryfall_id単位）の過去USD価格を取得する。個別プリントの価格推移グラフ用
 * （src/lib/dbCardPrintPrices.ts、getPrintPriceHistory）。JPY換算は呼び出し側で行う
 * （日付ごとのexchange_ratesが必要なため）。
 */
export async function getArchivedPrintPriceHistoryUsd(
  scryfallId: string,
  finish: "normal" | "foil" = "normal",
): Promise<{ date: string; usd: number }[]> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const db = (env as unknown as Env).PRICE_ARCHIVE_DB;
    if (!db) return [];

    const column = finish === "foil" ? "usd_foil" : "usd";
    const result = await db
      .prepare(
        `SELECT date, ${column} AS price FROM print_price_history_archive WHERE scryfall_id = ?1 AND ${column} IS NOT NULL ORDER BY date ASC`,
      )
      .bind(scryfallId)
      .all<{ date: string; price: number }>();

    return (result.results ?? []).map((row: { date: string; price: number }) => ({
      date: row.date,
      usd: Number(row.price),
    }));
  } catch {
    return [];
  }
}
