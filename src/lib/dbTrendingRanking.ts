import { supabase } from "./supabase";

const RANKING_SIZE = 10;

// 基本土地は採用率が常に高水準で推移し、3日程度の短期変化は本質的にノイズなため除外する
// （scripts/lib配下ではなくsrc/lib/dbCardRanking.tsの同名セットと同じ判断基準）
const BASIC_LAND_NAMES = new Set([
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
  "Wastes",
  "Snow-Covered Plains",
  "Snow-Covered Island",
  "Snow-Covered Swamp",
  "Snow-Covered Mountain",
  "Snow-Covered Forest",
]);

export interface TrendingRankingRow {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  priceJpy: number;
  priceChangePct: number | null;
  usageChangePt: number | null;
  usageFormat: string | null;
  compositeScore: number;
}

/**
 * trending_scores（scripts/compute-trending-scores.mjsが日次で計算）の最新calculated_date分から、
 * 「注目カードランキング」用に価格・採用率の3日変化を合成したスコア順のデータを組み立てる。
 *
 * price_change_3d_pctはoracle_id単位（フォーマット非依存、compute-trending-scores.mjs参照）で
 * 同じ値がフォーマットごとに重複して保存されているため1件に潰す。usage_change_3d_ptは
 * フォーマットごとに別値なので、oracle単位では最も変化幅が大きいフォーマットを代表として使う。
 *
 * 値下がり・採用率低下はカードの評価が上がったことを意味しないため、プラスの変化のみを
 * スコアに採用する（マイナスの変化は無視し、0点扱い＝表示もしない）。
 * 単位が違う（%とpt）ため単純合算はできない。今回取得した候補内でのプラス値の最大で
 * それぞれ0〜1に正規化してから足し合わせ、スコアが大きい順に並べる。
 * データがまだ無い場合は空配列を返す（呼び出し側でTODO表示のままにする想定）。
 */
export async function getTrendingRankingFromDb(): Promise<TrendingRankingRow[]> {
  const { data: latestRow } = await supabase
    .from("trending_scores")
    .select("calculated_date")
    .order("calculated_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRow) return [];

  const { data: scoreRows, error } = await supabase
    .from("trending_scores")
    .select("oracle_id, format, category, price_change_3d_pct, usage_change_3d_pt")
    .eq("calculated_date", latestRow.calculated_date);
  if (error || !scoreRows || scoreRows.length === 0) return [];

  // 値下がり・採用率低下はプラス評価にならないため、プラスの変化だけを候補として拾う
  const priceByOracle = new Map<string, number>();
  const usageByOracle = new Map<string, { pt: number; format: string }>();
  for (const row of scoreRows) {
    if (row.category === "price" && row.price_change_3d_pct != null) {
      const pct = Number(row.price_change_3d_pct);
      if (pct <= 0) continue;
      const existing = priceByOracle.get(row.oracle_id);
      if (existing == null || pct > existing) priceByOracle.set(row.oracle_id, pct);
    } else if (row.category === "usage" && row.usage_change_3d_pt != null) {
      const pt = Number(row.usage_change_3d_pt);
      if (pt <= 0) continue;
      const existing = usageByOracle.get(row.oracle_id);
      if (!existing || pt > existing.pt) {
        usageByOracle.set(row.oracle_id, { pt, format: row.format });
      }
    }
  }

  const { data: basicLandOracles } = await supabase
    .from("card_oracles")
    .select("oracle_id")
    .in("name", [...BASIC_LAND_NAMES]);
  const basicLandOracleIds = new Set((basicLandOracles ?? []).map((o) => o.oracle_id));

  const oracleIds = new Set(
    [...priceByOracle.keys(), ...usageByOracle.keys()].filter((id) => !basicLandOracleIds.has(id)),
  );
  if (oracleIds.size === 0) return [];

  const maxPrice = Math.max(0, ...priceByOracle.values());
  const maxUsage = Math.max(0, ...[...usageByOracle.values()].map((v) => v.pt));

  const candidates = [...oracleIds].map((oracleId) => {
    const priceChangePct = priceByOracle.get(oracleId) ?? null;
    const usage = usageByOracle.get(oracleId) ?? null;
    const priceNorm = priceChangePct != null && maxPrice > 0 ? priceChangePct / maxPrice : 0;
    const usageNorm = usage != null && maxUsage > 0 ? usage.pt / maxUsage : 0;
    return {
      oracleId,
      priceChangePct,
      usageChangePt: usage?.pt ?? null,
      usageFormat: usage?.format ?? null,
      compositeScore: priceNorm + usageNorm,
    };
  });

  const top = candidates.sort((a, b) => b.compositeScore - a.compositeScore).slice(0, RANKING_SIZE);
  if (top.length === 0) return [];

  const topOracleIds = top.map((c) => c.oracleId);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", topOracleIds),
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop").in("oracle_id", topOracleIds),
    supabase
      .from("card_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", topOracleIds)
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
  const priceByOracleJpy = new Map<string, number>();
  for (const p of priceRows ?? []) {
    if (!priceByOracleJpy.has(p.oracle_id) && p.jpy_est !== null) {
      priceByOracleJpy.set(p.oracle_id, Number(p.jpy_est));
    }
  }

  return top
    .map((c) => {
      const oracle = nameByOracle.get(c.oracleId);
      const priceJpy = priceByOracleJpy.get(c.oracleId);
      const artCropUrl = artCropByOracle.get(c.oracleId);
      if (!oracle || priceJpy === undefined || !artCropUrl) return null;
      return {
        oracleId: c.oracleId,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        artCropUrl,
        priceJpy,
        priceChangePct: c.priceChangePct,
        usageChangePt: c.usageChangePt,
        usageFormat: c.usageFormat,
        compositeScore: c.compositeScore,
      } satisfies TrendingRankingRow;
    })
    .filter((r): r is TrendingRankingRow => r !== null);
}
