import { supabase } from "./supabase";
import type { Format } from "./formats";
import type { RankingRow } from "./sampleRankingData";
import { colorsFromManaCost } from "./manaColors";

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
 * priceChangePct（3日変化率）はcard_price_snapshotsの最新日と3日前の日付を比較して算出する
 * （scripts/compute-trending-scores.mjsと同じ方式）。3日前のスナップショットが無いカードは
 * 変化なし(0)として扱う。
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

  const [{ data: oracles }, { data: cardRows }, { data: priceRows }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", topOracleIds),
    supabase
      .from("cards")
      .select("oracle_id, lang, image_uri_art_crop, mana_cost")
      .in("oracle_id", topOracleIds),
    supabase
      .from("card_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", topOracleIds)
      .eq("series", "en")
      .order("date", { ascending: false }),
  ]);

  const nameByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o]));

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

  const priceByOracle = new Map<string, number>();
  let latestDate: string | null = null;
  for (const p of priceRows ?? []) {
    if (!priceByOracle.has(p.oracle_id) && p.jpy_est !== null) {
      priceByOracle.set(p.oracle_id, Number(p.jpy_est));
      if (latestDate === null || p.date > latestDate) latestDate = p.date;
    }
  }

  // 3日前の日付ちょうどのスナップショットと比較する（priceRowsは既に全期間分取得済みなので
  // 追加クエリ不要）。無ければ変化なし(0)扱い。
  const priceChangeByOracle = new Map<string, number>();
  if (latestDate) {
    const pastDate = new Date(`${latestDate}T00:00:00Z`);
    pastDate.setUTCDate(pastDate.getUTCDate() - 3);
    const pastDateStr = pastDate.toISOString().slice(0, 10);
    const pastPriceByOracle = new Map<string, number>();
    for (const p of priceRows ?? []) {
      if (p.date === pastDateStr && p.jpy_est !== null && !pastPriceByOracle.has(p.oracle_id)) {
        pastPriceByOracle.set(p.oracle_id, Number(p.jpy_est));
      }
    }
    for (const [oracleId, price] of priceByOracle) {
      const past = pastPriceByOracle.get(oracleId);
      if (past != null && past !== 0) {
        priceChangeByOracle.set(oracleId, Math.round(((price - past) / past) * 10000) / 100);
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
