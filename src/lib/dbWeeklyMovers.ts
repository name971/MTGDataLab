import { supabase } from "./supabase";
import { getBestCardImages } from "./dbCardPrints";
import { colorsFromManaCost } from "./manaColors";

export type MoverCategory = "price" | "usage";

export const WEEKLY_MOVERS_PAGE_SIZE = 20;
export const WEEKLY_MOVERS_TOP_N = 100;

export interface WeeklyMoverRow {
  oracleId: string;
  rank: number;
  nameJa: string;
  nameEn: string;
  imageUrl: string;
  colors: string[];
  changeValue: number; // price: %／usage: pt
  /** usageのみ、この変化幅の元になった代表フォーマット（英語のFormat値そのまま、表示バッジ用） */
  format: string | null;
  /** フォーマットフィルター用。直近のcard_usage_statsに採用実績がある全フォーマット
   * （複数選択フィルターに対応するため配列。採用実績が無いカードは空配列） */
  formats: string[];
  priceJpy: number | null; // 価格帯フィルター用の現在価格。データが無い場合のみnull
}

export function formatChangeUnit(category: MoverCategory): string {
  return category === "price" ? "%" : "pt";
}

/**
 * weekly_movers（scripts/compute-weekly-movers.mjsが日次で計算）の最新calculated_date分から、
 * 指定カテゴリ・ページ分のランキング行を組み立てる。1ページ20件、Top100（5ページ）まで。
 */
export async function getWeeklyMovers(
  category: MoverCategory,
  page: number,
): Promise<{ rows: WeeklyMoverRow[]; totalCount: number }> {
  const { data: latestRow } = await supabase
    .from("weekly_movers")
    .select("calculated_date")
    .order("calculated_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRow) return { rows: [], totalCount: 0 };

  const offset = (page - 1) * WEEKLY_MOVERS_PAGE_SIZE;
  const { data: moverRows, count } = await supabase
    .from("weekly_movers")
    .select("oracle_id, format, change_value, rank", { count: "exact" })
    .eq("calculated_date", latestRow.calculated_date)
    .eq("category", category)
    .order("rank", { ascending: true })
    .range(offset, offset + WEEKLY_MOVERS_PAGE_SIZE - 1);
  if (!moverRows || moverRows.length === 0) return { rows: [], totalCount: count ?? 0 };

  const oracleIds = moverRows.map((r) => r.oracle_id);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }, bestImageByOracle, formatsByOracle] =
    await Promise.all([
      supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", oracleIds),
      supabase.from("cards").select("oracle_id, mana_cost").eq("lang", "en").in("oracle_id", oracleIds),
      supabase.from("card_current_prices").select("oracle_id, jpy_est").in("oracle_id", oracleIds),
      getBestCardImages(oracleIds),
      getFormatsByOracle(oracleIds),
    ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));
  const manaCostByOracle = new Map((cardRows ?? []).map((c) => [c.oracle_id, c.mana_cost]));
  const priceByOracle = new Map<string, number>();
  for (const p of priceRows ?? []) {
    if (!priceByOracle.has(p.oracle_id) && p.jpy_est !== null) priceByOracle.set(p.oracle_id, Number(p.jpy_est));
  }

  const rows = moverRows
    .map((m) => {
      const oracle = nameByOracle.get(m.oracle_id);
      const imageUrl = bestImageByOracle.get(m.oracle_id);
      if (!oracle || !imageUrl) return null;
      return {
        oracleId: m.oracle_id,
        rank: m.rank,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        imageUrl,
        colors: colorsFromManaCost(manaCostByOracle.get(m.oracle_id)),
        changeValue: Number(m.change_value),
        format: m.format,
        formats: formatsByOracle.get(m.oracle_id) ?? [],
        priceJpy: priceByOracle.get(m.oracle_id) ?? null,
      } satisfies WeeklyMoverRow;
    })
    .filter((r): r is WeeklyMoverRow => r !== null);

  return { rows, totalCount: Math.min(count ?? 0, WEEKLY_MOVERS_TOP_N) };
}

/**
 * オラクルごとに、直近のcard_usage_statsに採用実績がある全フォーマットを返す
 * （dbMlRanking.tsのgetFormatsByOracleと同じ考え方、複数選択フィルター用）。
 */
async function getFormatsByOracle(oracleIds: string[]): Promise<Map<string, string[]>> {
  const { data: latestUsageRow } = await supabase
    .from("card_usage_stats")
    .select("calculated_at")
    .order("calculated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestUsageRow) return new Map();

  const { data: usageRows } = await supabase
    .from("card_usage_stats")
    .select("oracle_id, format")
    .eq("calculated_at", latestUsageRow.calculated_at)
    .in("oracle_id", oracleIds);

  const formatsByOracle = new Map<string, Set<string>>();
  for (const r of usageRows ?? []) {
    if (!formatsByOracle.has(r.oracle_id)) formatsByOracle.set(r.oracle_id, new Set());
    formatsByOracle.get(r.oracle_id)!.add(r.format);
  }
  return new Map([...formatsByOracle.entries()].map(([oracleId, set]) => [oracleId, [...set]]));
}
