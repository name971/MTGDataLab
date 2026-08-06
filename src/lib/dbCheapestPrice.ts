import { supabase } from "./supabase";
import type { PricePoint } from "./dbPriceHistory";
import { getArchivedPriceHistory } from "./priceArchiveDb";

export interface CheapestPriceSnapshot {
  usd: number | null;
  jpyEst: number | null;
  usdFoil: number | null;
  jpyEstFoil: number | null;
  scryfallId: string | null;
  scryfallIdFoil: string | null;
}

/**
 * card_current_prices（scripts/compute-cheapest-price-snapshots.mjsが日次更新、
 * db/schema.sql）から、そのオラクルの「今、全プリント中最安値」を取得する。
 * 代表プリント（新セット追加時にしか選び直さない）と違い、日次で全プリントを見直しているため、
 * カード詳細ページのメイン価格表示はこちらを優先して使う。
 * 1オラクル1行のキャッシュテーブルなので、date順のソートは不要（DB容量超過対応）。
 */
export async function getLatestCheapestPrice(oracleId: string): Promise<CheapestPriceSnapshot | null> {
  const { data, error } = await supabase
    .from("card_current_prices")
    .select("usd, jpy_est, usd_foil, jpy_est_foil, scryfall_id, scryfall_id_foil")
    .eq("oracle_id", oracleId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    usd: data.usd,
    jpyEst: data.jpy_est,
    usdFoil: data.usd_foil,
    jpyEstFoil: data.jpy_est_foil,
    scryfallId: data.scryfall_id,
    scryfallIdFoil: data.scryfall_id_foil,
  };
}

/**
 * カード詳細ページのメイン価格推移グラフ用。finish="foil"でFoil版の最安値推移を返す。
 * 各日の最安値がどのセットだったか（setCode）も一緒に返す。日によって最安のセットが
 * 入れ替わっていることが伝わるよう、価格推移グラフのホバー時にセットのアイコンを出すため。
 *
 * Supabase無料枠対策で、90日より古いcard_cheapest_price_snapshotsはD1（アーカイブ用、
 * scripts/archive-old-price-snapshots.mjs）へ移してSupabase側からは削除している。
 * そのため「全期間」表示はSupabase（直近）とD1（それ以前）の両方から取得して結合する
 * （アーカイブ分にはsetCode/setNameが無いため、そこはundefinedのまま表示側でフォールバックする）。
 */
export async function getCheapestPriceHistory(
  oracleId: string,
  finish: "normal" | "foil" = "normal",
): Promise<PricePoint[]> {
  const priceColumn = finish === "foil" ? "jpy_est_foil" : "jpy_est";
  const scryfallIdColumn = finish === "foil" ? "scryfall_id_foil" : "scryfall_id";

  // 日付フィルタ無しの全期間取得だと、蓄積日数が1000日（約2.7年）を超えたときに
  // PostgRESTのデフォルト上限で昇順の先頭側＝古い日付しか返らず最新価格が欠落する
  // （src/lib/dbPriceHistory.tsで実際に踏んだのと同じ問題）。ページングする。
  const PAGE_SIZE = 1000;
  const allRows: { date: string; price: number | null; scryfall_id: string | null }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("card_cheapest_price_snapshots")
      .select(`date, price:${priceColumn}, scryfall_id:${scryfallIdColumn}`)
      .eq("oracle_id", oracleId)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<{ date: string; price: number | null; scryfall_id: string | null }[]>();
    if (error) return [];
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  const rows = allRows.filter(
    (row): row is { date: string; price: number; scryfall_id: string | null } => row.price !== null,
  );

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

  const recent = rows.map((row) => ({
    date: row.date,
    jpy: Number(row.price),
    setCode: row.scryfall_id ? setCodeByScryfallId.get(row.scryfall_id) : undefined,
    setName: row.scryfall_id ? setNameByScryfallId.get(row.scryfall_id) : undefined,
  }));

  // アーカイブ側はSupabaseの最も古い日付より前の分だけを使う（重複除去）。
  // D1が使えない・アーカイブがまだ無い環境では空配列が返るだけで、直近データの表示に影響しない。
  const earliestRecentDate = recent[0]?.date;
  const archived = await getArchivedPriceHistory(oracleId, finish);
  const archivedBeforeRecent = earliestRecentDate
    ? archived.filter((p) => p.date < earliestRecentDate)
    : archived;

  return [...archivedBeforeRecent, ...recent];
}
