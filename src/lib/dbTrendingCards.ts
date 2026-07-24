import { supabase } from "./supabase";
import type { TrendingCardData } from "@/components/TrendingCard";

const CARDS_PER_CATEGORY = 2;

/**
 * trending_scores（scripts/compute-trending-scores.mjsが日次で計算）の最新calculated_date分から、
 * トップページの「注目カード」用データを組み立てる。同じカードが複数フォーマットに跨って
 * 上位に来ることがあるため、カテゴリごとにoracle_id単位で変化幅が最大のものだけ残してから
 * 上位CARDS_PER_CATEGORY件に絞る。
 * データがまだ無い（3日分蓄積前・当日分未計算等）場合は空配列を返す（呼び出し側でサンプルに
 * フォールバックする想定）。
 */
export async function getTrendingCardsFromDb(): Promise<TrendingCardData[]> {
  const { data: latestRow } = await supabase
    .from("trending_scores")
    .select("calculated_date")
    .order("calculated_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRow) return [];

  const { data: scoreRows, error } = await supabase
    .from("trending_scores")
    .select("oracle_id, category, price_change_3d_pct, usage_change_3d_pt, score, streak_days")
    .eq("calculated_date", latestRow.calculated_date);
  if (error || !scoreRows || scoreRows.length === 0) return [];

  const bestByOracleAndCategory = new Map<string, (typeof scoreRows)[number]>();
  for (const row of scoreRows) {
    const key = `${row.oracle_id}|${row.category}`;
    const existing = bestByOracleAndCategory.get(key);
    if (!existing || Math.abs(row.score) > Math.abs(existing.score)) {
      bestByOracleAndCategory.set(key, row);
    }
  }

  const topByCategory = (category: "price" | "usage") =>
    [...bestByOracleAndCategory.values()]
      .filter((r) => r.category === category)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, CARDS_PER_CATEGORY);

  const picked = [...topByCategory("price"), ...topByCategory("usage")];
  if (picked.length === 0) return [];

  const oracleIds = picked.map((r) => r.oracle_id);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", oracleIds),
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop").in("oracle_id", oracleIds),
    supabase
      .from("card_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", oracleIds)
      .eq("series", "en")
      .order("date", { ascending: false }),
  ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));
  const artCropByOracle = new Map<string, string>();
  for (const c of cardRows ?? []) {
    const existing = artCropByOracle.get(c.oracle_id);
    if (c.image_uri_art_crop && (c.lang === "ja" || !existing)) {
      artCropByOracle.set(c.oracle_id, c.image_uri_art_crop);
    }
  }
  const priceByOracle = new Map<string, number>();
  for (const p of priceRows ?? []) {
    if (!priceByOracle.has(p.oracle_id) && p.jpy_est !== null) {
      priceByOracle.set(p.oracle_id, Number(p.jpy_est));
    }
  }

  return picked
    .map((row) => {
      const oracle = nameByOracle.get(row.oracle_id);
      const priceJpy = priceByOracle.get(row.oracle_id);
      const artCropUrl = artCropByOracle.get(row.oracle_id);
      if (!oracle || priceJpy === undefined || !artCropUrl) return null;
      const changeLabel =
        row.category === "price"
          ? `${row.price_change_3d_pct! >= 0 ? "+" : ""}${row.price_change_3d_pct}%`
          : `${row.usage_change_3d_pt! >= 0 ? "+" : ""}${row.usage_change_3d_pt}pt`;
      return {
        oracleId: row.oracle_id,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        artCropUrl,
        category: row.category as "price" | "usage",
        priceJpy,
        changeLabel,
        streakDays: row.streak_days,
      } satisfies TrendingCardData;
    })
    .filter((c): c is TrendingCardData => c !== null);
}
