/**
 * trending_scores（注目カードランキング、db/schema.sql）を計算する。
 * 価格・採用率それぞれの「3日前との変化」を比較する必要があるため、
 * card_cheapest_price_snapshots / card_usage_stats に3日以上前のデータが無い場合は
 * 何も投入せずスキップする（0%や偽の変化率を書き込まない）。
 *
 * 取引量（volume）は無料データソースが無いため対象外（docs/spec.md 2章）。
 * category は 'price' | 'usage' の2種のみ、各フォーマットごとに変化幅の大きい順に保存する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/compute-trending-scores.mjs
 */

import { monthsBetween, readOraclePriceMonths } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// 日次価格履歴はcard_cheapest_price_snapshots（Supabase）ではなくR2
// （price-history、月次NDJSON.gz、scripts/compute-cheapest-price-snapshots.mjsが日次で
// 書き込む）側にしかない（DB容量超過対応の再設計でSupabase側は「今の価格」1行キャッシュ
// のみになった）。今回必要な日付（今日・3日前・前日）はどれも当月か前月に収まるため、
// 前月〜今月の2ヶ月分だけ読み込んでメモリ上でフィルタする。
let cachedPriceRowsPromise = null;
function loadRecentOraclePriceRows() {
  if (!cachedPriceRowsPromise) {
    const today = new Date();
    const lastMonth = new Date(today);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const months = monthsBetween(isoDate(lastMonth), isoDate(today));
    cachedPriceRowsPromise = readOraclePriceMonths(months);
  }
  return cachedPriceRowsPromise;
}

async function findLatestD1DateAtOrBefore(targetDate) {
  const rows = await loadRecentOraclePriceRows();
  let latest = null;
  for (const r of rows) {
    if (r.date <= targetDate && (!latest || r.date > latest)) latest = r.date;
  }
  return latest;
}

async function getD1PricesForDate(date) {
  if (!date) return [];
  const rows = await loadRecentOraclePriceRows();
  return rows.filter((r) => r.date === date && r.jpy_est != null);
}

const LOOKBACK_DAYS = 3;
const TOP_N_PER_CATEGORY = 10;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// trending_scoresのprice_change_3d_pct/usage_change_3d_pt/scoreはNUMERIC(6,2)（絶対値9999.99が
// 上限）。数円の激安カードが数百円になった等、%換算すると桁違いに巨大な値になるケースで
// upsert自体がnumeric field overflowで失敗し、後続のcard_streaks/ML予測ステップまで巻き添えで
// 未実行になった事故が実際に発生した（2026-08-21）。表示上も9999.99%を超える値に意味は無いため
// クランプする。
const NUMERIC_6_2_MAX = 9999.99;
function clampPct(value) {
  if (value == null) return value;
  return Math.max(-NUMERIC_6_2_MAX, Math.min(NUMERIC_6_2_MAX, value));
}

const PAGE_SIZE = 1000; // PostgRESTのデフォルト最大行数（db-max-rows）に合わせてページングする

async function supabaseGet(path) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

async function supabaseUpsert(table, rows, conflictColumn) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
}

/**
 * 指定日以前で、そのテーブル・条件に該当する最新の日付を1件探す。
 * 「ちょうどN日前」の厳密一致だと、その日だけ日次バッチが動かなかった（実際に
 * 2026-07-28分が丸ごと欠けたことがあった）だけで計算全体がスキップされてしまうため、
 * 「N日前以前で一番近い日」を使えるようにする。
 */
async function findLatestDateAtOrBefore(table, dateColumn, extraFilter, targetDate) {
  const rows = await supabaseGet(
    `${table}?select=${dateColumn}&${extraFilter}&${dateColumn}=lte.${targetDate}&order=${dateColumn}.desc&limit=1`,
  );
  return rows[0]?.[dateColumn] ?? null;
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const pastDate = new Date(today);
  pastDate.setDate(pastDate.getDate() - LOOKBACK_DAYS);
  const pastStr = isoDate(pastDate);

  // 価格は「代表プリント」ではなく、カード詳細ページと同じ「全プリント中の最安値」
  // （card_cheapest_price_snapshots）を基準にする。代表プリントは選び直しの頻度が低く、
  // より安いプリントが出ても反映されないため、値上がり検知の基準としてはズレることがあった。
  const resolvedTodayPriceDate = await findLatestD1DateAtOrBefore(todayStr);
  const resolvedPastPriceDate = await findLatestD1DateAtOrBefore(pastStr);
  if (!resolvedTodayPriceDate || !resolvedPastPriceDate) {
    console.log(
      `価格スナップショットに${pastStr}以前のデータがありません（${LOOKBACK_DAYS}日分の蓄積待ち）。trending_scoresの計算をスキップします。`,
    );
    return;
  }

  // ── 価格の3日変化（フォーマット非依存、oracle_id単位） ──
  const [priceToday, pricePast] = await Promise.all([
    getD1PricesForDate(resolvedTodayPriceDate),
    getD1PricesForDate(resolvedPastPriceDate),
  ]);

  const pricePastMap = new Map(pricePast.map((r) => [r.oracle_id, Number(r.jpy_est)]));
  const priceTodayMap = new Map(priceToday.map((r) => [r.oracle_id, Number(r.jpy_est)]));
  const priceChangeByOracle = new Map(); // oracle_id -> pct
  for (const row of priceToday) {
    const past = pricePastMap.get(row.oracle_id);
    if (past == null || past === 0) continue;
    const pct = ((Number(row.jpy_est) - past) / past) * 100;
    priceChangeByOracle.set(row.oracle_id, Math.round(pct * 100) / 100);
  }

  // 継続日数（streak_days）は「カード自身の価格/採用率が前日比で実際に上がり続けている日数」を
  // 表す（以前は「そのフォーマットで1位のカードであり続けた日数」だったため、1位が入れ替わると
  // 実際には値上がりしているカードの継続日数がリセットされ、逆に前日比では下がっているのに
  // 1位を維持しているだけのカードが「N日連続」と表示される食い違いがあった）。
  // そのため前日の生の価格・採用率も別途取得する。
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayDateStr = isoDate(yesterdayDate);
  const resolvedYesterdayPriceDate = await findLatestD1DateAtOrBefore(yesterdayDateStr);
  const priceYesterday = await getD1PricesForDate(resolvedYesterdayPriceDate);
  const priceYesterdayMap = new Map(priceYesterday.map((r) => [r.oracle_id, Number(r.jpy_est)]));

  const resolvedTodayUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", todayStr);
  const resolvedPastUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", pastStr);
  if (!resolvedTodayUsageDate || !resolvedPastUsageDate) {
    console.log(
      `card_usage_statsに${pastStr}以前のデータがありません（${LOOKBACK_DAYS}日分の蓄積待ち）。trending_scoresの計算をスキップします。`,
    );
    return;
  }

  // ── 採用率の3日変化（フォーマット×oracle_id単位） ──
  const [usageToday, usagePast] = await Promise.all([
    supabaseGet(
      `card_usage_stats?select=format,oracle_id,usage_rate,deck_sample_size&calculated_at=eq.${resolvedTodayUsageDate}`,
    ),
    supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedPastUsageDate}`),
  ]);

  const usagePastMap = new Map(usagePast.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));
  const usageTodayMap = new Map(usageToday.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));
  const usageChangeByKey = new Map(); // "format|oracle_id" -> pt
  for (const row of usageToday) {
    const key = `${row.format}|${row.oracle_id}`;
    const past = usagePastMap.get(key);
    if (past == null) continue;
    const pt = Number(row.usage_rate) - past;
    usageChangeByKey.set(key, Math.round(pt * 100) / 100);
  }

  const resolvedYesterdayUsageDate = await findLatestDateAtOrBefore(
    "card_usage_stats",
    "calculated_at",
    "",
    yesterdayDateStr,
  );
  const usageYesterday = resolvedYesterdayUsageDate
    ? await supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedYesterdayUsageDate}`)
    : [];
  const usageYesterdayMap = new Map(usageYesterday.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));

  // 前日分のtrending_scoresを取得し、オラクル単位の継続日数を引き継ぐ（1位固定ではなく
  // オラクルごとに持たせる。1位が入れ替わっても、そのカード自身が値上がりし続けていれば
  // 継続日数が正しく積み上がるようにするため）。
  const yesterdayStr = yesterdayDateStr;
  const yesterdayRows = await supabaseGet(
    `trending_scores?select=oracle_id,format,category,streak_days&calculated_date=eq.${yesterdayStr}&score=not.is.null`
  );
  const yesterdayStreakByKey = new Map(); // "format|category|oracle_id" -> streak_days
  for (const row of yesterdayRows) {
    yesterdayStreakByKey.set(`${row.format}|${row.category}|${row.oracle_id}`, row.streak_days);
  }

  const formats = [...new Set(usageToday.map((r) => r.format))];
  const rows = [];

  // price category: フォーマット（＝card_usage_statsに採用記録があるか）に関係なく、
  // 価格データがある全カードを対象にする（採用率データが無いカードでも値上がりだけで
  // 注目カードランキングの候補になれるようにするため）。card_streaksのprice category
  // と同じくフォーマット非依存でformat='ALL'として1回だけ保存する。
  const priceMovers = [...priceChangeByOracle.entries()]
    .map(([oracleId, pct]) => ({ oracleId, pct }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, TOP_N_PER_CATEGORY);

  priceMovers.forEach((r) => {
    const todayPrice = priceTodayMap.get(r.oracleId);
    const yestPrice = priceYesterdayMap.get(r.oracleId);
    const prevStreak = yesterdayStreakByKey.get(`ALL|price|${r.oracleId}`) ?? 0;
    // 前日の生データが両方揃っている時だけ厳密判定。前日比で実際に上がっていれば継続、
    // 下がっている（or横ばい）なら継続リセット。前日データが無ければ判定不能なので1日目扱い。
    const streak =
      todayPrice != null && yestPrice != null ? (todayPrice > yestPrice ? prevStreak + 1 : 0) : 1;
    rows.push({
      oracle_id: r.oracleId,
      format: "ALL",
      calculated_date: todayStr,
      price_change_3d_pct: clampPct(r.pct),
      usage_change_3d_pt: null,
      volume_change_3d_pct: null,
      category: "price",
      score: clampPct(r.pct),
      streak_days: streak,
    });
  });

  for (const format of formats) {
    // card_usage_statsは7/30/90日分など複数期間分の行を持つため、同じoracle_idが
    // 複数回出てくることがある。重複したままだと同一upsertバッチ内でON CONFLICTが
    // 同じ行に2回作用してエラーになるため、フォーマット内でoracle_id単位に重複除去する。
    const formatOracleIds = [
      ...new Set(usageToday.filter((r) => r.format === format).map((r) => r.oracle_id)),
    ];

    // usage category: 採用率の変化幅順
    const usageMovers = formatOracleIds
      .map((oracleId) => ({ oracleId, pt: usageChangeByKey.get(`${format}|${oracleId}`) }))
      .filter((r) => r.pt != null && r.pt !== 0)
      .sort((a, b) => Math.abs(b.pt) - Math.abs(a.pt))
      .slice(0, TOP_N_PER_CATEGORY);

    usageMovers.forEach((r) => {
      const todayRate = usageTodayMap.get(`${format}|${r.oracleId}`);
      const yestRate = usageYesterdayMap.get(`${format}|${r.oracleId}`);
      const prevStreak = yesterdayStreakByKey.get(`${format}|usage|${r.oracleId}`) ?? 0;
      const streak = todayRate != null && yestRate != null ? (todayRate > yestRate ? prevStreak + 1 : 0) : 1;
      rows.push({
        oracle_id: r.oracleId,
        format,
        calculated_date: todayStr,
        price_change_3d_pct: null,
        usage_change_3d_pt: r.pt,
        volume_change_3d_pct: null,
        category: "usage",
        score: r.pt,
        streak_days: streak,
      });
    });
  }

  // upsertは新規/更新のみで、今回trip10から外れた（=今回のrowsに含まれない）oracle_id×format×category
  // の古い行は消されずに残り続けてしまう（実際に、値上がり率が下がって順位から落ちたカードの
  // 古いスコアが別フォーマットの行に残り続ける事故が発生した）。当日分は毎回作り直すものなので、
  // 保存前に当日分を一度全部消してから入れ直し、古い行が残らないようにする。
  await supabaseDelete(`trending_scores?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("trending_scores", rows, "oracle_id,format,calculated_date,category");
  console.log(`trending_scores 保存: ${rows.length}件（${formats.length}フォーマット分）`);

  // 保持ポリシー: 継続日数(streak_days)の引き継ぎには前日分だけ必要で、それより古い行は
  // 表示・計算のどちらにも使われず積み上がるだけなので削除する
  await supabaseDelete(`trending_scores?calculated_date=lt.${yesterdayStr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
