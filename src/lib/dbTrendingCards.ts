import { supabase } from "./supabase";
import type { TrendingCardData } from "@/components/TrendingCard";

const CARDS_PER_CATEGORY = 2;

// 「注目カードランキング」（src/lib/dbTrendingRanking.ts）が当日時点の合成スコアの瞬間値で
// 並べているのに対し、こちらは何日連続で値上がり/採用率上昇のトップであり続けているか
// （streak_days）を主役にして役割を分ける。閾値以上の連続日数があるカードが無い日は
// 1段階ずつ緩めて、それでも見つからなければ空配列（呼び出し側でサンプルにフォールバック）。
const STREAK_THRESHOLDS = [3, 2, 1];

/**
 * trending_scores（scripts/compute-trending-scores.mjsが日次で計算）の最新calculated_date分から、
 * トップページの「注目カード」（継続的に値上がり/採用率上昇しているカード）用データを組み立てる。
 * 値下がり・採用率低下は評価が上がったことを意味しないため、プラスの変化のみを対象にする
 * （src/lib/dbTrendingRanking.tsと同じ方針）。
 * 同じカードが複数フォーマットに跨って上位に来ることがあるため、カテゴリごとにoracle_id単位で
 * 連続日数が最大のものだけ残してから上位CARDS_PER_CATEGORY件に絞る。
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
    .select("oracle_id, category, price_change_3d_pct, usage_change_3d_pt, streak_days")
    .eq("calculated_date", latestRow.calculated_date);
  if (error || !scoreRows || scoreRows.length === 0) return [];

  const risingRows = scoreRows.filter((r) =>
    r.category === "price" ? (r.price_change_3d_pct ?? 0) > 0 : (r.usage_change_3d_pt ?? 0) > 0,
  );

  const bestByOracleAndCategory = new Map<string, (typeof risingRows)[number]>();
  for (const row of risingRows) {
    const key = `${row.oracle_id}|${row.category}`;
    const existing = bestByOracleAndCategory.get(key);
    if (!existing || row.streak_days > existing.streak_days) {
      bestByOracleAndCategory.set(key, row);
    }
  }
  const candidates = [...bestByOracleAndCategory.values()];

  const topByCategory = (category: "price" | "usage", minStreak: number) =>
    candidates
      .filter((r) => r.category === category && r.streak_days >= minStreak)
      .sort((a, b) => b.streak_days - a.streak_days)
      .slice(0, CARDS_PER_CATEGORY);

  // 閾値を満たすカードが両カテゴリ合わせてCARDS_PER_CATEGORY*2件に届くまで、段階的に緩める
  let picked: (typeof risingRows)[number][] = [];
  for (const minStreak of STREAK_THRESHOLDS) {
    picked = [...topByCategory("price", minStreak), ...topByCategory("usage", minStreak)];
    if (picked.length >= CARDS_PER_CATEGORY * 2) break;
  }
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
