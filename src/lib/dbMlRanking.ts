import { supabase } from "./supabase";
import { getBestCardImages } from "./dbCardPrints";
import { colorsFromManaCost } from "./manaColors";

const RANKING_SIZE = 100; // ページ切り替えで最大100件まで閲覧できる

export interface MlRankingRow {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  priceJpy: number;
  /** 7日以内に+5/10/15/20%以上値動きする確率（0〜1、キャリブレーション済み・単調性保証済み） */
  p5: number;
  p10: number;
  p15: number;
  p20: number;
  /** フォーマットフィルター用の表示専用メタデータ。予測モデル自体はフォーマット横断で
   * 特徴量をプールしており「どのフォーマットで使われているか」を持たないため、
   * card_usage_statsに採用実績があるフォーマットを（複数選択フィルターに対応できるよう）
   * 全て列挙する（採用実績が無いカードは空配列）。 */
  formats: string[];
  /** 色フィルター用（RankingFilterPanel.tsx参照）。EN版のmana_costから導出、両面カード等で
   * 取得できなかった場合は空配列（無色/取得不可を区別しない） */
  colors: string[];
  /** レアリティフィルター用（RankingFilterPanel.tsx参照）。EN版のcards.rarityから取得。 */
  rarity: string | null;
  /** 予測時点(calculated_at)から直近までの実績変化率(%)。scripts/update-ml-prediction-
   * outcomes.mjsが日次で埋める。バッチ未実行分・価格履歴が無い分はnull。 */
  currentPctChange: number | null;
  /** 予測時点〜直近までの間で一番良かった結果(%、direction沿い)。同スクリプトが埋める。 */
  extremePctChange: number | null;
  /** この予測が計算された日（YYYY-MM-DD）。全行同じ値（1回のバッチ実行分のみ返すため）。 */
  calculatedAt: string;
}

/**
 * ml/predict_and_publish.py が書き込んだcard_price_predictions（competitiveセグメント、
 * LightGBM分類器による「7日以内に+X%以上値上がりする確率」の段階表示、p_5が最も緩い
 * 閾値で順位を決めている）から注目カードランキングを組み立てる。
 * docs/price-prediction-plan.md 8〜9章参照。
 *
 * 単一の「注目度」スコアではなく、閾値ごとの確率をそのまま見せる
 * （ユーザー指摘: 知りたいのは「上がるかどうか」だけでなく「どれくらい上がるか」でもある。
 * 2026-08-16）。
 *
 * 現時点では日次自動更新はまだ組み込んでいない（採用率アーカイブのR2永続化が
 * 未完了、docs/price-prediction-plan.md参照）。ml/predict_and_publish.pyの手動実行で
 * 更新する運用。
 */
export async function getMlRankingFromDb(
  direction: "up" | "down" = "up",
): Promise<MlRankingRow[]> {
  // 2026-08-21、的中率の事後検証用に過去分も残す設計へ変更した（PRIMARY KEYにcalculated_at
  // が加わり1オラクルにつき複数日分の行を持つ、db/schema.sql参照）ため、表示には
  // 最新calculated_atの行だけを使う必要がある。
  const { data: latestRow, error: latestError } = await supabase
    .from("card_price_predictions")
    .select("calculated_at")
    .eq("direction", direction)
    .order("calculated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`getMlRankingFromDb: ${latestError.message}`);
  if (!latestRow) return [];

  const { data: rows, error } = await supabase
    .from("card_price_predictions")
    .select("oracle_id, rank, p_5, p_10, p_15, p_20, jpy_est, current_pct_change, extreme_pct_change")
    .eq("direction", direction)
    .eq("calculated_at", latestRow.calculated_at)
    .order("rank", { ascending: true })
    .limit(RANKING_SIZE);
  // errorは接続/クエリ失敗、rows=[]はまだ予測が無いだけ、で意味が違う（dbTrendingCards.ts参照）
  if (error) throw new Error(`getMlRankingFromDb: ${error.message}`);
  if (!rows || rows.length === 0) return [];

  const oracleIds = rows.map((r) => r.oracle_id);
  const [{ data: oracles }, { data: cardRows }, bestImageByOracle, formatsByOracle] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", oracleIds),
    supabase.from("cards").select("oracle_id, lang, image_uri_art_crop, mana_cost, rarity").in("oracle_id", oracleIds),
    getBestCardImages(oracleIds),
    getFormatsByOracle(oracleIds),
  ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));
  // カード詳細ページの画像選定（安い順+日本語版一致、getBestCardImage）と揃える。
  // 反映漏れの場合のみcardsテーブルの代表プリント画像にフォールバックする
  // （dbTrendingRanking.tsのgetTrendingRankingFromDbと同じロジック）。
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
  const manaCostByOracle = new Map<string, string | null>();
  const rarityByOracle = new Map<string, string | null>();
  for (const c of cardRows ?? []) {
    if (c.lang === "en") {
      manaCostByOracle.set(c.oracle_id, c.mana_cost);
      rarityByOracle.set(c.oracle_id, c.rarity);
    }
  }

  return rows
    .map((row) => {
      const oracle = nameByOracle.get(row.oracle_id);
      const artCropUrl = artCropByOracle.get(row.oracle_id);
      if (!oracle || !artCropUrl) return null;
      return {
        oracleId: row.oracle_id,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        artCropUrl,
        priceJpy: Number(row.jpy_est),
        p5: Number(row.p_5),
        p10: Number(row.p_10),
        p15: Number(row.p_15),
        p20: Number(row.p_20),
        formats: formatsByOracle.get(row.oracle_id) ?? [],
        colors: colorsFromManaCost(manaCostByOracle.get(row.oracle_id)),
        rarity: rarityByOracle.get(row.oracle_id) ?? null,
        currentPctChange: row.current_pct_change == null ? null : Number(row.current_pct_change),
        extremePctChange: row.extreme_pct_change == null ? null : Number(row.extreme_pct_change),
        calculatedAt: latestRow.calculated_at,
      } satisfies MlRankingRow;
    })
    .filter((r): r is MlRankingRow => r !== null);
}

/**
 * オラクルごとに、直近のcard_usage_statsに採用実績があるフォーマットを全て列挙する
 * （複数選択フィルターに対応するため、1件だけの代表値ではなく配列で返す）。
 * フィルター表示専用の軽量メタデータで、予測モデルの特徴量には使わない
 * （getMlRankingFromDb参照）。
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
