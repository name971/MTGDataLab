import { supabase } from "./supabase";
import type { Format } from "./formats";
import type { RankingRow } from "./sampleRankingData";
import { colorsFromManaCost } from "./manaColors";
import { getBestCardImages } from "./dbCardPrints";

// 色フィルタで絞り込んでも表示件数が残るよう、表示用（20件）より広めに候補を取得する
const TOP_N = 100;

// 基本土地は常に採用率が高くランキングの大半を占めてしまい、値上がり/採用率ランキングとしての
// 意味が薄いため除外する（雪だらけ版含む）
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

/**
 * card_usage_stats（採用率）を軸に、そのフォーマットで実際によく使われているカードの
 * ランキングをDBの実データから組み立てる。card_usage_statsに行が無いフォーマットは
 * 空配列を返す（呼び出し側でサンプルデータにフォールバックする想定）。
 * priceChangePct（3日変化率）はcard_cheapest_price_snapshots（全プリント横断の最安値）の
 * 最新日と3日前の日付を比較して算出する（scripts/compute-trending-scores.mjsと同じ方式）。
 * 3日前のスナップショットが無いカードは変化なし(0)として扱う。
 */
export async function getCardRankingFromDb(
  format: Format,
  periodDays: 7 | 30 | 90 = 30,
): Promise<RankingRow[]> {
  // Supabase/PostgRESTは1リクエスト最大1000行までしか返さない。Commander等は同一
  // calculated_atだけで1000件を超えるため、.range()でページングしないと採用率上位のカードが
  // 黙って切り捨てられ、たまたま残った無関係な低採用率カードが「上位」に見えてしまう。
  const PAGE_SIZE = 1000;
  const usageRows: { oracle_id: string; usage_rate: number; calculated_at: string }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("card_usage_stats")
      .select("oracle_id, usage_rate, calculated_at")
      .eq("format", format)
      .eq("period_days", periodDays)
      .order("calculated_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error || !page || page.length === 0) break;
    usageRows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  if (usageRows.length === 0) return [];

  // 最新日のusage_rateだけを1オラクル1件に絞る
  const latestUsageByOracle = new Map<string, number>();
  for (const row of usageRows) {
    if (!latestUsageByOracle.has(row.oracle_id)) {
      latestUsageByOracle.set(row.oracle_id, Number(row.usage_rate));
    }
  }

  // 基本土地のoracle_idだけを名前で引く（候補全件をin()で問い合わせるとURLが長くなりすぎるカードが
  // 多いフォーマットで失敗するため、基本土地という少数の既知の名前から逆引きする）
  const { data: basicLandOracles } = await supabase
    .from("card_oracles")
    .select("oracle_id")
    .in("name", [...BASIC_LAND_NAMES]);
  const basicLandOracleIds = new Set((basicLandOracles ?? []).map((o) => o.oracle_id));

  const topOracleIds = [...latestUsageByOracle.entries()]
    .filter(([oracleId]) => !basicLandOracleIds.has(oracleId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([oracleId]) => oracleId);

  if (topOracleIds.length === 0) return [];

  // card_cheapest_price_snapshotsはtopOracleId(最大100件)×蓄積日数分の行があり、蓄積が進むと
  // 1000行を超える（例: 100件×10日で1000行）。ページングしないと日付降順の後方＝
  // 一部オラクルの直近データが切り捨てられ、priceChangePctが不正確になる。
  const PRICE_PAGE_SIZE = 1000;
  const priceRows: { oracle_id: string; jpy_est: number | null; date: string }[] = [];
  for (let offset = 0; ; offset += PRICE_PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("card_cheapest_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", topOracleIds)
      .order("date", { ascending: false })
      .range(offset, offset + PRICE_PAGE_SIZE - 1);
    if (error || !page || page.length === 0) break;
    priceRows.push(...page);
    if (page.length < PRICE_PAGE_SIZE) break;
  }

  const [{ data: oracles }, { data: cardRows }, bestImageByOracle] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", topOracleIds),
    supabase
      .from("cards")
      .select("oracle_id, lang, image_uri_art_crop, mana_cost")
      .in("oracle_id", topOracleIds),
    getBestCardImages(topOracleIds),
  ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));

  // カード詳細ページの「カードデータ」画像選定（安い順+日本語版一致、getBestCardImage）と揃える。
  // card_prints未反映等でgetBestCardImagesが決められなかった場合のみ、cardsテーブルの
  // 代表プリント画像にフォールバックする。
  const artCropByOracle = new Map<string, string>();
  const manaCostByOracle = new Map<string, string>();
  for (const c of cardRows ?? []) {
    const existing = artCropByOracle.get(c.oracle_id);
    if (c.image_uri_art_crop && (c.lang === "ja" || !existing)) {
      artCropByOracle.set(c.oracle_id, c.image_uri_art_crop);
    }
    if (c.lang === "en" && c.mana_cost) {
      manaCostByOracle.set(c.oracle_id, c.mana_cost);
    }
  }
  for (const [oracleId, normalUrl] of bestImageByOracle) {
    artCropByOracle.set(oracleId, normalUrl.replace("/normal/", "/art_crop/"));
  }

  const priceByOracle = new Map<string, number>();
  let latestDate: string | null = null;
  for (const p of priceRows ?? []) {
    if (!priceByOracle.has(p.oracle_id) && p.jpy_est !== null) {
      priceByOracle.set(p.oracle_id, Number(p.jpy_est));
      if (latestDate === null || p.date > latestDate) latestDate = p.date;
    }
  }

  // 3日前「ちょうど」の日付と厳密一致でしか比較しないと、その日だけ日次バッチが
  // 動いていない（実際に2026-07-28分が丸ごと欠けていたことがあった）だけで対象カード
  // 全件が変化なし(0%)になってしまう。3日前以前で一番近い日のスナップショットを使う
  // （priceRowsは既に全期間分取得済みなので追加クエリ不要）。
  const priceChangeByOracle = new Map<string, number>();
  if (latestDate) {
    const pastDate = new Date(`${latestDate}T00:00:00Z`);
    pastDate.setUTCDate(pastDate.getUTCDate() - 3);
    const pastDateStr = pastDate.toISOString().slice(0, 10);
    const pastPriceByOracle = new Map<string, { date: string; price: number }>();
    for (const p of priceRows ?? []) {
      if (p.jpy_est === null || p.date > pastDateStr) continue;
      const existing = pastPriceByOracle.get(p.oracle_id);
      if (!existing || p.date > existing.date) {
        pastPriceByOracle.set(p.oracle_id, { date: p.date, price: Number(p.jpy_est) });
      }
    }
    for (const [oracleId, price] of priceByOracle) {
      const past = pastPriceByOracle.get(oracleId);
      if (past != null && past.price !== 0) {
        priceChangeByOracle.set(oracleId, Math.round(((price - past.price) / past.price) * 10000) / 100);
      }
    }
  }

  const rows: RankingRow[] = topOracleIds
    .map((oracleId) => {
      const oracle = nameByOracle.get(oracleId);
      const priceJpy = priceByOracle.get(oracleId);
      const artCropUrl = artCropByOracle.get(oracleId);
      // 価格・画像・名前のいずれかが無いカードはランキング表示に耐えないので除外する
      if (!oracle || priceJpy === undefined || !artCropUrl) return null;
      return {
        oracleId,
        nameJa: oracle.printed_name_ja ?? oracle.name,
        nameEn: oracle.name,
        artCropUrl,
        priceJpy,
        priceChangePct: priceChangeByOracle.get(oracleId) ?? 0,
        usageRatePct: latestUsageByOracle.get(oracleId) ?? 0,
        colors: colorsFromManaCost(manaCostByOracle.get(oracleId)),
      } satisfies RankingRow;
    })
    .filter((r): r is RankingRow => r !== null);

  return rows;
}
