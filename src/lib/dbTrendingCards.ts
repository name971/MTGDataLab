import { supabase } from "./supabase";
import type { TrendingCardData } from "@/components/TrendingCard";
import { getBestCardImages } from "./dbCardPrints";

const CARDS_PER_CATEGORY = 2;

// 基本土地は採用率が常に高水準で推移し、短期変化は本質的にノイズなため除外する
// （src/lib/dbCardRanking.ts・dbTrendingRanking.tsの同名セットと同じ判断基準）
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

interface StreakRow {
  oracle_id: string;
  category: "price" | "usage";
  format: string;
  streak_days: number;
  change_value: number;
  calculated_date: string;
}

/**
 * そのカテゴリの候補（同じcalculated_dateの行のみ）から、streak_days降順
 * （同着は変化量が大きい方を優先）で上位CARDS_PER_CATEGORY件を返す。
 * usageはフォーマットごとに別行があるため、オラクルごとに一番良い（streak最長、同着なら
 * 変化量最大の）行だけを残してから順位付けする（price行はもともとformat='ALL'固定で1件のみ）。
 */
function pickForCategory(rows: StreakRow[], category: "price" | "usage") {
  const bestByOracle = new Map<string, StreakRow>();
  for (const row of rows) {
    if (row.category !== category) continue;
    const existing = bestByOracle.get(row.oracle_id);
    if (
      !existing ||
      row.streak_days > existing.streak_days ||
      (row.streak_days === existing.streak_days && row.change_value > existing.change_value)
    ) {
      bestByOracle.set(row.oracle_id, row);
    }
  }
  return [...bestByOracle.values()]
    .sort((a, b) => b.streak_days - a.streak_days || b.change_value - a.change_value)
    .slice(0, CARDS_PER_CATEGORY);
}

/**
 * card_streaks（scripts/compute-card-streaks.mjsが日次で計算）から、トップページの
 * 「継続注目カード」用データを組み立てる。
 *
 * card_streaksは、カード詳細ページのグラフと同じ生データ（card_cheapest_price_snapshots・
 * card_usage_stats）を全カード対象に走査して「前日比で何日連続で上がり続けているか」を
 * 正確に計算した結果で、trending_scores（1日あたり上位10件だけの3日変化スコア、
 * 注目カードランキング用）とは別物。日ごとにデータを作り直す（streak_days=0の行は
 * 保存しない）ため、その日実際に連続上昇しているカードだけが対象になる。
 * 価格・採用率それぞれ独立に、streak_days最長のカードを2枚選ぶ（同着は変化量が大きい方）。
 * データがまだ無い場合は空配列を返す（呼び出し側でサンプルにフォールバックする想定）。
 */
export async function getTrendingCardsFromDb(): Promise<TrendingCardData[]> {
  const { data: latestRow } = await supabase
    .from("card_streaks")
    .select("calculated_date")
    .order("calculated_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRow) return [];

  // card_streaksはある日、その日実際に連続上昇しているカード全件（数万件規模になりうる）を
  // 保存している。ここで必要なのは各カテゴリの上位数件だけなので、全件取得してJS側で絞り込む
  // のではなく、DB側でstreak_days・change_value降順にソート・上位だけをLIMITして取得する
  // （全件ページングは行数が多い日にサブリクエスト過多で失敗し、フォールバック表示になる
  // 事故が実際に発生した）。基本土地除外で数件減る可能性に備え、少し多めに取っておく。
  const CANDIDATE_LIMIT = CARDS_PER_CATEGORY + 20;
  // 3つとも互いに依存しないため並列実行する
  const [{ data: priceRowsRaw }, { data: usageRowsRaw }, { data: basicLandOracles }] = await Promise.all([
    supabase
      .from("card_streaks")
      .select("oracle_id, category, format, streak_days, change_value, calculated_date")
      .eq("calculated_date", latestRow.calculated_date)
      .eq("category", "price")
      .order("streak_days", { ascending: false })
      .order("change_value", { ascending: false })
      .limit(CANDIDATE_LIMIT),
    supabase
      .from("card_streaks")
      .select("oracle_id, category, format, streak_days, change_value, calculated_date")
      .eq("calculated_date", latestRow.calculated_date)
      .eq("category", "usage")
      .order("streak_days", { ascending: false })
      .order("change_value", { ascending: false })
      .limit(CANDIDATE_LIMIT),
    supabase.from("card_oracles").select("oracle_id").in("name", [...BASIC_LAND_NAMES]),
  ]);
  const streakRows = [...(priceRowsRaw ?? []), ...(usageRowsRaw ?? [])] as StreakRow[];
  if (streakRows.length === 0) return [];
  const basicLandOracleIds = new Set((basicLandOracles ?? []).map((o) => o.oracle_id));
  const candidateRows = streakRows.filter((r) => !basicLandOracleIds.has(r.oracle_id));

  const picked = [...pickForCategory(candidateRows, "price"), ...pickForCategory(candidateRows, "usage")];
  if (picked.length === 0) return [];

  const oracleIds = picked.map((r) => r.oracle_id);
  const [{ data: oracles }, { data: cardRows }, { data: priceRows }, bestImageByOracle] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", oracleIds),
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop").in("oracle_id", oracleIds),
    supabase.from("card_current_prices").select("oracle_id, jpy_est").in("oracle_id", oracleIds),
    getBestCardImages(oracleIds),
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
          ? `${row.change_value >= 0 ? "+" : ""}${row.change_value}%`
          : `${row.change_value >= 0 ? "+" : ""}${row.change_value}pt`;
      return {
        oracleId: row.oracle_id,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        artCropUrl,
        category: row.category,
        priceJpy,
        changeLabel,
        streakDays: row.streak_days,
        asOfDate: row.calculated_date,
      } satisfies TrendingCardData;
    })
    .filter((c): c is TrendingCardData => c !== null);
}
