import { supabase } from "./supabase";
import type { TrendingCardData } from "@/components/TrendingCard";

const CARDS_PER_CATEGORY = 2;

// 「注目カードランキング」（src/lib/dbTrendingRanking.ts）が当日時点の合成スコアの瞬間値で
// 並べているのに対し、こちらは何日連続で値上がり/採用率上昇のトップであり続けているか
// （streak_days）を主役にして役割を分ける。閾値以上の連続日数があるカードが無い日は
// 1段階ずつ緩めて、それでも見つからなければ空配列（呼び出し側でサンプルにフォールバック）。
const STREAK_THRESHOLDS = [3, 2, 1];

// 「継続注目カード」という名前なのに、1日だけの異常値（例: 未解決デッキの大量バックログ解消で
// 採用率の母数が急増し、その日は全カードで採用率がマイナスになった）でカテゴリごと消えてしまうのは
// 不自然なので、直近何日か遡って「その日プラスの候補が1件でもあった最新の日」を探す。
const LOOKBACK_DAYS = 5;

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ScoreRow {
  oracle_id: string;
  category: "price" | "usage";
  price_change_3d_pct: number | null;
  usage_change_3d_pt: number | null;
  streak_days: number;
  calculated_date: string;
}

function topByCategory(rows: ScoreRow[], category: "price" | "usage", minStreak: number) {
  return rows
    .filter((r) => r.category === category && r.streak_days >= minStreak)
    .sort((a, b) => b.streak_days - a.streak_days)
    .slice(0, CARDS_PER_CATEGORY);
}

/** そのカテゴリについて、直近の日から遡って最初にプラスの候補が見つかった日の結果を返す */
function pickForCategory(rowsByDate: Map<string, ScoreRow[]>, sortedDates: string[], category: "price" | "usage") {
  for (const date of sortedDates) {
    const rows = rowsByDate.get(date) ?? [];
    const bestByOracle = new Map<string, ScoreRow>();
    for (const row of rows) {
      const existing = bestByOracle.get(row.oracle_id);
      if (!existing || row.streak_days > existing.streak_days) bestByOracle.set(row.oracle_id, row);
    }
    const candidates = [...bestByOracle.values()];
    for (const minStreak of STREAK_THRESHOLDS) {
      const picked = topByCategory(candidates, category, minStreak);
      if (picked.length > 0) return picked;
    }
  }
  return [];
}

/**
 * trending_scores（scripts/compute-trending-scores.mjsが日次で計算）から、トップページの
 * 「注目カード」（継続的に値上がり/採用率上昇しているカード）用データを組み立てる。
 * 値下がり・採用率低下は評価が上がったことを意味しないため、プラスの変化のみを対象にする
 * （src/lib/dbTrendingRanking.tsと同じ方針）。
 * 価格・採用率はそれぞれ独立に、直近LOOKBACK_DAYS日の中で最新の「プラス候補が存在する日」を
 * 採用する（1日だけの異常値でカテゴリごと消えるのを防ぐため）。
 * データがまだ無い場合は空配列を返す（呼び出し側でサンプルにフォールバックする想定）。
 */
export async function getTrendingCardsFromDb(): Promise<TrendingCardData[]> {
  const today = new Date();
  const dates: string[] = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(isoDate(d));
  }

  const { data: scoreRows, error } = await supabase
    .from("trending_scores")
    .select("oracle_id, category, price_change_3d_pct, usage_change_3d_pt, streak_days, calculated_date")
    .in("calculated_date", dates)
    .gt("score", 0); // マイナスの変化は評価が上がったことを意味しないので候補にしない
  if (error || !scoreRows || scoreRows.length === 0) return [];

  const { data: basicLandOracles } = await supabase
    .from("card_oracles")
    .select("oracle_id")
    .in("name", [...BASIC_LAND_NAMES]);
  const basicLandOracleIds = new Set((basicLandOracles ?? []).map((o) => o.oracle_id));

  const rowsByDate = new Map<string, ScoreRow[]>();
  for (const row of scoreRows as ScoreRow[]) {
    if (basicLandOracleIds.has(row.oracle_id)) continue;
    if (!rowsByDate.has(row.calculated_date)) rowsByDate.set(row.calculated_date, []);
    rowsByDate.get(row.calculated_date)!.push(row);
  }
  const sortedDates = [...rowsByDate.keys()].sort((a, b) => (a < b ? 1 : -1));

  const picked = [
    ...pickForCategory(rowsByDate, sortedDates, "price"),
    ...pickForCategory(rowsByDate, sortedDates, "usage"),
  ];
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
        category: row.category,
        priceJpy,
        changeLabel,
        streakDays: row.streak_days,
        asOfDate: row.calculated_date,
      } satisfies TrendingCardData;
    })
    .filter((c): c is TrendingCardData => c !== null);
}
