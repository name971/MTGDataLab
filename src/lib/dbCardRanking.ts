import { supabase } from "./supabase";
import type { Format } from "./formats";
import type { RankingRow } from "./sampleRankingData";
import { colorsFromManaCost } from "./manaColors";
import { getBestCardImages } from "./dbCardPrints";
import { getR2RecentPriceChanges } from "./priceArchiveR2";

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
  async function fetchUsageRows() {
    const rows: { oracle_id: string; usage_rate: number; calculated_at: string }[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: page, error } = await supabase
        .from("card_usage_stats")
        .select("oracle_id, usage_rate, calculated_at")
        .eq("format", format)
        .eq("period_days", periodDays)
        .order("calculated_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error || !page || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  }

  // 基本土地のoracle_idだけを名前で引く（候補全件をin()で問い合わせるとURLが長くなりすぎるカードが
  // 多いフォーマットで失敗するため、基本土地という少数の既知の名前から逆引きする）。
  // usageRowsのページング取得とは互いに依存しないので並列実行する。
  const [usageRows, { data: basicLandOracles }] = await Promise.all([
    fetchUsageRows(),
    supabase.from("card_oracles").select("oracle_id").in("name", [...BASIC_LAND_NAMES]),
  ]);

  if (usageRows.length === 0) return [];

  // 最新日のusage_rateだけを1オラクル1件に絞る
  const latestUsageByOracle = new Map<string, number>();
  for (const row of usageRows) {
    if (!latestUsageByOracle.has(row.oracle_id)) {
      latestUsageByOracle.set(row.oracle_id, Number(row.usage_rate));
    }
  }

  const basicLandOracleIds = new Set((basicLandOracles ?? []).map((o) => o.oracle_id));

  const topOracleIds = [...latestUsageByOracle.entries()]
    .filter(([oracleId]) => !basicLandOracleIds.has(oracleId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([oracleId]) => oracleId);

  if (topOracleIds.length === 0) return [];

  // card_cheapest_price_snapshots（Supabase）は日次の新規書き込みが無くなり常に空のため、
  // 3日前比の変化率は事前計算済みキャッシュ（R2、price-changes/latest.ndjson.gz、
  // scripts/compute-cheapest-price-snapshots.mjsが日次で計算）から取る。全オラクル分が
  // 1ファイルにまとまっているため、オラクルごとに個別リクエストする必要が無い
  // （以前はオラクル単位で個別GetObjectしていて、100件規模だとラウンドトリップが
  // 積み重なり数秒〜十数秒かかっていた）。
  const recentChanges = await getR2RecentPriceChanges();

  const [{ data: oracles }, { data: cardRows }, bestImageByOracle, { data: currentPriceRows }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, name, printed_name_ja").in("oracle_id", topOracleIds),
    supabase
      .from("cards")
      .select("oracle_id, lang, image_uri_art_crop, mana_cost")
      .in("oracle_id", topOracleIds),
    getBestCardImages(topOracleIds),
    supabase.from("card_current_prices").select("oracle_id, jpy_est").in("oracle_id", topOracleIds),
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
  for (const p of currentPriceRows ?? []) {
    if (p.jpy_est !== null) priceByOracle.set(p.oracle_id, Number(p.jpy_est));
  }

  const rows = topOracleIds
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
        priceChangePct: recentChanges.get(oracleId)?.priceChange3dPct ?? 0,
        usageRatePct: latestUsageByOracle.get(oracleId) ?? 0,
        colors: colorsFromManaCost(manaCostByOracle.get(oracleId)),
      } satisfies RankingRow;
    })
    .filter((r) => r !== null) as RankingRow[];

  return rows;
}
