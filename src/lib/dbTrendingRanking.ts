import { supabase } from "./supabase";
import { getBestCardImages } from "./dbCardPrints";

const RANKING_SIZE = 10;

// Pawlicki et al. "Prediction of Price Increase for Magic: The Gathering Cards"（Stanford CS229, 2014）では
// 価格・採用率・販売量の3日差分特徴のうち、採用率の3日差分（U_D - U_D-3）が単独で最も予測に効いていた
// （取引量は無料データソースが無く使えないため、その代替シグナルとして採用率をより重く見る）。
const USAGE_WEIGHT = 1.5;

// 同論文は1〜6日前までの複数日差分を特徴量として使い、直近の値動きほど強い指標としていた。
// 単日のスナップショットノイズによる偶発的な変化と、複数日にわたって同方向に動き続けている
// 継続的なトレンドを区別するため、直近1日・3日・6日の3区間が同方向に動いているかを見て、
// 一致した区間数だけスコアを割り増しする（最大+45%）。
const TREND_BONUS_PER_STEP = 0.15;
const TREND_CHECK_LOOKBACK_DAYS = [1, 3, 6] as const;

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

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, delta: number) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

/**
 * 日付昇順（過去→現在）に並んだ値の並びのうち、隣接区間が「変化の符号」と同じ向きに
 * 動いている区間数を数える（データが欠けている区間はカウントに含めない）。
 * 例: [90, 95, 98, 100]で符号が+なら3区間とも一致で3を返す。
 */
function countConsistentSteps(valuesOldToNew: (number | undefined)[], sign: number) {
  let count = 0;
  for (let i = 1; i < valuesOldToNew.length; i++) {
    const prev = valuesOldToNew[i - 1];
    const cur = valuesOldToNew[i];
    if (prev == null || cur == null) continue;
    if (Math.sign(cur - prev) === sign) count++;
  }
  return count;
}

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
  /** 表示用の相対注目度（このランキング内の最上位を100とした0〜100）。%とptは単位が違って
   * 直接比較できないため、順位の根拠はこちらで見せ、生の値は補足情報として添える。 */
  attentionScore: number;
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
 * それぞれ0〜1に正規化した上で、採用率側にUSAGE_WEIGHTを掛けて重めに評価し（根拠は
 * USAGE_WEIGHTのコメント参照）、さらに直近1・3・6日が同方向に動き続けているトレンドには
 * TREND_BONUS_PER_STEPで割り増ししてから足し合わせ、スコアが大きい順に並べる。
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

  // 1日分でもフォーマット×カテゴリ×オラクルの組み合わせが増えると1000行を超えうるため、
  // PostgRESTのデフォルト上限に備えてページングする（他のdb*.tsで実際に踏んだのと同じ問題）。
  const SCORE_PAGE_SIZE = 1000;
  const scoreRows: {
    oracle_id: string;
    format: string;
    category: string;
    price_change_3d_pct: number | null;
    usage_change_3d_pt: number | null;
  }[] = [];
  for (let offset = 0; ; offset += SCORE_PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("trending_scores")
      .select("oracle_id, format, category, price_change_3d_pct, usage_change_3d_pt")
      .eq("calculated_date", latestRow.calculated_date)
      .range(offset, offset + SCORE_PAGE_SIZE - 1);
    if (error) return [];
    if (!page || page.length === 0) break;
    scoreRows.push(...page);
    if (page.length < SCORE_PAGE_SIZE) break;
  }
  if (scoreRows.length === 0) return [];

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

  // トレンドの継続性を見るため、pivot日から1・3・6日前の生の価格・採用率を候補分だけ追加取得する
  // （trending_scoresには3日差分の計算結果しか保存されていないため、多日分の系列は別途引く必要がある）
  const candidateOracleIds = [...oracleIds];
  const pivotDate = latestRow.calculated_date as string;
  const lookbackDates = TREND_CHECK_LOOKBACK_DAYS.map((d) => addDays(pivotDate, -d));
  const allDates = [pivotDate, ...lookbackDates];

  const [{ data: priceSeriesRows }, { data: usageSeriesRows }] = await Promise.all([
    supabase
      .from("card_cheapest_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", candidateOracleIds)
      .in("date", allDates),
    supabase
      .from("card_usage_stats")
      .select("oracle_id, format, usage_rate, calculated_at")
      .in("oracle_id", candidateOracleIds)
      .in("calculated_at", allDates),
  ]);

  const priceSeriesByOracle = new Map<string, Map<string, number>>();
  for (const r of priceSeriesRows ?? []) {
    if (r.jpy_est == null) continue;
    if (!priceSeriesByOracle.has(r.oracle_id)) priceSeriesByOracle.set(r.oracle_id, new Map());
    priceSeriesByOracle.get(r.oracle_id)!.set(r.date, Number(r.jpy_est));
  }
  const usageSeriesByOracleFormat = new Map<string, Map<string, number>>();
  for (const r of usageSeriesRows ?? []) {
    const key = `${r.oracle_id}|${r.format}`;
    if (!usageSeriesByOracleFormat.has(key)) usageSeriesByOracleFormat.set(key, new Map());
    usageSeriesByOracleFormat.get(key)!.set(r.calculated_at, Number(r.usage_rate));
  }
  // countConsistentStepsは古い→新しい順の並びを前提とするため、日付降順で作ったallDatesを反転する
  const datesOldToNew = [...allDates].reverse();

  const candidates = candidateOracleIds.map((oracleId) => {
    const priceChangePct = priceByOracle.get(oracleId) ?? null;
    const usage = usageByOracle.get(oracleId) ?? null;

    const priceSteps = priceSeriesByOracle.get(oracleId);
    const priceTrendSteps =
      priceChangePct != null && priceSteps
        ? countConsistentSteps(
            datesOldToNew.map((d) => priceSteps.get(d)),
            1,
          )
        : 0;
    const priceTrendMultiplier = 1 + TREND_BONUS_PER_STEP * priceTrendSteps;

    const usageSteps = usage ? usageSeriesByOracleFormat.get(`${oracleId}|${usage.format}`) : undefined;
    const usageTrendSteps = usage && usageSteps
      ? countConsistentSteps(
          datesOldToNew.map((d) => usageSteps.get(d)),
          1,
        )
      : 0;
    const usageTrendMultiplier = 1 + TREND_BONUS_PER_STEP * usageTrendSteps;

    const priceNorm = priceChangePct != null && maxPrice > 0 ? (priceChangePct / maxPrice) * priceTrendMultiplier : 0;
    const usageNorm =
      usage != null && maxUsage > 0 ? (usage.pt / maxUsage) * USAGE_WEIGHT * usageTrendMultiplier : 0;
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

  const maxCompositeScore = top[0].compositeScore;

  const topOracleIds = top.map((c) => c.oracleId);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }, bestImageByOracle] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", topOracleIds),
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop").in("oracle_id", topOracleIds),
    supabase
      .from("card_cheapest_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", topOracleIds)
      .order("date", { ascending: false }),
    getBestCardImages(topOracleIds),
  ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));
  // カード詳細ページの「カードデータ」画像選定（安い順+日本語版一致、getBestCardImage）と揃える。
  // card_prints未反映等でgetBestCardImagesが決められなかった場合のみ、cardsテーブルの
  // 代表プリント画像にフォールバックする。
  const artCropByOracle = new Map<string, string>();
  for (const c of cardRows ?? []) {
    const existing = artCropByOracle.get(c.oracle_id);
    if (c.image_uri_art_crop && (c.lang === "ja" || !existing)) {
      artCropByOracle.set(c.oracle_id, c.image_uri_art_crop);
    }
  }
  for (const [oracleId, normalUrl] of bestImageByOracle) {
    artCropByOracle.set(oracleId, normalUrl.replace("/normal/", "/art_crop/"));
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
        attentionScore:
          maxCompositeScore > 0 ? Math.round((c.compositeScore / maxCompositeScore) * 100) : 0,
      } satisfies TrendingRankingRow;
    })
    .filter((r): r is TrendingRankingRow => r !== null);
}
