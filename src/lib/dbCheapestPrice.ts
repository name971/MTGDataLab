import { supabase } from "./supabase";
import type { PricePoint } from "./dbPriceHistory";

export interface CheapestPriceSnapshot {
  usd: number | null;
  jpyEst: number | null;
  usdFoil: number | null;
  jpyEstFoil: number | null;
  scryfallId: string | null;
  scryfallIdFoil: string | null;
}

/**
 * card_cheapest_price_snapshots（scripts/compute-cheapest-price-snapshots.mjsが日次計算、
 * db/schema.sql）から、そのオラクルの最新日の「全プリント中最安値」を取得する。
 * 代表プリント（新セット追加時にしか選び直さない）と違い、日次で全プリントを見直しているため、
 * カード詳細ページのメイン価格表示はこちらを優先して使う。
 */
export async function getLatestCheapestPrice(oracleId: string): Promise<CheapestPriceSnapshot | null> {
  const { data, error } = await supabase
    .from("card_cheapest_price_snapshots")
    .select("usd, jpy_est, usd_foil, jpy_est_foil, scryfall_id, scryfall_id_foil")
    .eq("oracle_id", oracleId)
    .order("date", { ascending: false })
    .limit(1)
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

  return rows.map((row) => ({
    date: row.date,
    jpy: Number(row.price),
    setCode: row.scryfall_id ? setCodeByScryfallId.get(row.scryfall_id) : undefined,
    setName: row.scryfall_id ? setNameByScryfallId.get(row.scryfall_id) : undefined,
  }));
}
