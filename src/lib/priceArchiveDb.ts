import type { PricePoint } from "./dbPriceHistory";
import { supabase } from "./supabase";

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

    const priceColumn = finish === "foil" ? "jpy_est_foil" : "jpy_est";
    const scryfallColumn = finish === "foil" ? "scryfall_id_foil" : "scryfall_id";
    const result = await db
      .prepare(
        `SELECT date, ${priceColumn} AS price, ${scryfallColumn} AS scryfall_id FROM price_history_archive WHERE oracle_id = ?1 AND ${priceColumn} IS NOT NULL ORDER BY date ASC`,
      )
      .bind(oracleId)
      .all<{ date: string; price: number; scryfall_id: string | null }>();

    const rows = result.results ?? [];
    // 各日の最安値がどのセットだったかは、旧アーカイブ分（scryfall_id列追加前）にはNULLしか
    // 無いことがある。その場合はセットアイコン無しで表示側がフォールバックする。
    const scryfallIds = [...new Set(rows.map((r) => r.scryfall_id).filter((id): id is string => id !== null))];
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
      jpy: Number(row.price),
      setCode: row.scryfall_id ? setCodeByScryfallId.get(row.scryfall_id) : undefined,
      setName: row.scryfall_id ? setNameByScryfallId.get(row.scryfall_id) : undefined,
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
