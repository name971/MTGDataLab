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
  rarity: string | null;
  changeValue: number; // price: %／price_jpy: 円／usage: pt
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
 * 指定カテゴリのTop100を全件まとめて返す。フィルター適用後にページごとの枚数が
 * 歯抜けにならないよう、ページングはWeeklyMoversList.tsx側でフィルター後の配列に対して
 * 行う（MlRankingList.tsxと同じ方式、2026-08-27）。
 */
export async function getWeeklyMovers(
  category: MoverCategory,
  /** priceカテゴリのみ、%上昇率ランキングか金額差ランキングかを切り替える。単なる表示単位の
   * 変換ではなく、compute-weekly-movers.mjsがそれぞれ別に算出したTop100（カード構成自体が
   * 異なりうる）を切り替える（2026-08-27、「単位を変えたいだけ」ではなく「別のランキングが
   * 見たい」という要望だった）。weekly_movers.categoryは"price_jpy"として別行で保存されている。 */
  priceMetric: "pct" | "jpy" = "pct",
): Promise<{ rows: WeeklyMoverRow[] }> {
  const storedCategory = category === "price" && priceMetric === "jpy" ? "price_jpy" : category;

  const { data: latestRow } = await supabase
    .from("weekly_movers")
    .select("calculated_date")
    .order("calculated_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRow) return { rows: [] };

  const { data: moverRows } = await supabase
    .from("weekly_movers")
    .select("oracle_id, format, change_value, rank")
    .eq("calculated_date", latestRow.calculated_date)
    .eq("category", storedCategory)
    .order("rank", { ascending: true })
    .limit(WEEKLY_MOVERS_TOP_N);
  if (!moverRows || moverRows.length === 0) return { rows: [] };

  const oracleIds = moverRows.map((r) => r.oracle_id);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }, bestImageByOracle, formatsByOracle] =
    await Promise.all([
      supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", oracleIds),
      supabase.from("cards").select("oracle_id, mana_cost, rarity").eq("lang", "en").in("oracle_id", oracleIds),
      supabase.from("card_current_prices").select("oracle_id, jpy_est").in("oracle_id", oracleIds),
      getBestCardImages(oracleIds),
      getFormatsByOracle(oracleIds),
    ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));
  const manaCostByOracle = new Map((cardRows ?? []).map((c) => [c.oracle_id, c.mana_cost]));
  const rarityByOracle = new Map((cardRows ?? []).map((c) => [c.oracle_id, c.rarity]));
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
        rarity: rarityByOracle.get(m.oracle_id) ?? null,
        changeValue: Number(m.change_value),
        format: m.format,
        formats: formatsByOracle.get(m.oracle_id) ?? [],
        priceJpy: priceByOracle.get(m.oracle_id) ?? null,
      } satisfies WeeklyMoverRow;
    })
    .filter((r): r is WeeklyMoverRow => r !== null);

  return { rows };
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
