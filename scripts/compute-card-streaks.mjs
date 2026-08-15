/**
 * card_streaks（「継続注目カード」トップページ用、db/schema.sql）を計算する。
 *
 * trending_scores（1日あたり上位10件しか保存しない・直近3日変化ベース）とは別物。
 * こちらは全カード対象に毎日「前日比で実際に何日連続で上がり続けているか」を計算する。
 *
 * 【設計】前日分のcard_streaks（streak_days・baseline_value）を引き継ぎ、「前日比プラスなら
 * +1日・そうでなければリセット」で当日分を計算する（compute-trending-scores.mjsの
 * streak引き継ぎと同じ方式）。
 *
 * 以前は直近60日分を毎回R2/Supabaseからスキャンし、配列の隣接要素同士（seriesOldToNew[i] vs
 * [i-1]）を比較する方式だった。この方式には2つの弱点があった:
 *   1. 日付が1日でも欠けると、隣接する配列要素が実際には連続した日でなくなり、
 *      本来ならリセットされるべき箇所が「連続」として誤集計される
 *   2. 60日分のウィンドウがデータソースの品質が異なる期間（過去にTCGCSVバックフィル分に
 *      使用不可プリントが混入していた等、docs/incident-log.md参照）を跨ぐと、
 *      直近の計算がその汚染の影響を受ける
 * 前日引き継ぎ方式なら、毎日「前日」「当日」の2点だけを見るため、過去に遡った期間の
 * データ品質に依存しない（汚染された過去データを直接読まなくなる）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/compute-card-streaks.mjs
 */

import { readRecentPriceChanges } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

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

async function supabaseUpsert(table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} upsert failed (chunk ${i}): ${res.status} ${await res.text()}`);
  }
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

/**
 * 前日分の継続日数・基準値を引き継ぎつつ、当日の値と比較して継続日数を更新する。
 * 前日比プラスなら継続（streak+1、baselineは前日から引き継いで据え置き）、
 * そうでなければリセット（streak=1、baselineは前日の値そのもの＝今日始まったばかりの起点）。
 * 前日の値が無い（欠測）場合は連続性を主張できないため1日目扱いにする。
 */
function nextStreak(prevStreakDays, prevBaseline, yesterdayValue, todayValue) {
  if (todayValue == null || yesterdayValue == null) return null;
  if (todayValue > yesterdayValue) {
    const continuing = prevStreakDays != null && prevBaseline != null;
    return {
      streakDays: continuing ? prevStreakDays + 1 : 1,
      baseline: continuing ? prevBaseline : yesterdayValue,
    };
  }
  return null; // 前日比プラスでなければstreak無し（保存しない）
}

function changeValueFrom(baseline, latest, asPercent) {
  if (baseline === 0) return null;
  const diff = asPercent ? ((latest - baseline) / baseline) * 100 : latest - baseline;
  return Math.round(diff * 100) / 100;
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const yesterdayStr = addDays(todayStr, -1);

  // 前日分（今日削除する前）のcard_streaksを読み、継続日数・基準値を引き継ぐ準備をする。
  const prevRows = await supabaseGet(
    `card_streaks?select=oracle_id,category,format,streak_days,baseline_value&calculated_date=eq.${yesterdayStr}`,
  );
  const prevByKey = new Map(prevRows.map((r) => [`${r.oracle_id}|${r.category}|${r.format}`, r]));

  const rows = [];

  // ── 価格（フォーマット非依存、全プリント横断の最安値） ──
  // 事前計算キャッシュ（price-changes/latest.ndjson.gz、compute-cheapest-price-snapshots.mjsが
  // 直近7日分の系列込みで日次書き込み）を1回読むだけで、全オラクル分の「今日」「前日」の
  // 価格が両方手に入る。
  const priceChangeRows = await readRecentPriceChanges();
  for (const r of priceChangeRows) {
    const todayValue = r.jpy_est != null ? Number(r.jpy_est) : null;
    const yesterdayEntry = (r.recent_series ?? []).find((p) => p.date === yesterdayStr);
    const yesterdayValue = yesterdayEntry ? Number(yesterdayEntry.jpy) : null;

    const prev = prevByKey.get(`${r.oracle_id}|price|ALL`);
    const next = nextStreak(
      prev?.streak_days ?? null,
      prev?.baseline_value != null ? Number(prev.baseline_value) : null,
      yesterdayValue,
      todayValue,
    );
    if (!next) continue;
    const changeValue = changeValueFrom(next.baseline, todayValue, true);
    if (changeValue == null) continue;
    rows.push({
      oracle_id: r.oracle_id,
      category: "price",
      format: "ALL",
      calculated_date: todayStr,
      streak_days: next.streakDays,
      change_value: changeValue,
      baseline_value: next.baseline,
    });
  }

  // ── 採用率（フォーマットごとに別値） ──
  // 採用率のstreak計算に使う集計期間。card_usage_statsは7/30/90日の3種類を持つが、
  // 日々の増減が一番はっきり出る（母数の入れ替わりが速い）7日を使う。
  const USAGE_PERIOD_DAYS = 7;
  const [usageToday, usageYesterday] = await Promise.all([
    supabaseGet(
      `card_usage_stats?select=oracle_id,format,usage_rate&period_days=eq.${USAGE_PERIOD_DAYS}&calculated_at=eq.${todayStr}`,
    ),
    supabaseGet(
      `card_usage_stats?select=oracle_id,format,usage_rate&period_days=eq.${USAGE_PERIOD_DAYS}&calculated_at=eq.${yesterdayStr}`,
    ),
  ]);
  const usageYesterdayByKey = new Map(usageYesterday.map((r) => [`${r.oracle_id}|${r.format}`, Number(r.usage_rate)]));

  for (const r of usageToday) {
    const key = `${r.oracle_id}|${r.format}`;
    const todayValue = Number(r.usage_rate);
    const yesterdayValue = usageYesterdayByKey.get(key) ?? null;

    const prev = prevByKey.get(`${r.oracle_id}|usage|${r.format}`);
    const next = nextStreak(
      prev?.streak_days ?? null,
      prev?.baseline_value != null ? Number(prev.baseline_value) : null,
      yesterdayValue,
      todayValue,
    );
    if (!next) continue;
    const changeValue = changeValueFrom(next.baseline, todayValue, false);
    if (changeValue == null) continue;
    rows.push({
      oracle_id: r.oracle_id,
      category: "usage",
      format: r.format,
      calculated_date: todayStr,
      streak_days: next.streakDays,
      change_value: changeValue,
      baseline_value: next.baseline,
    });
  }

  // dbTrendingCards.tsは常に最新のcalculated_dateしか読まないため、過去日分は保持する意味が無い。
  // 削除せず溜め続けるとcard_price_snapshots（削除済み、DB容量超過の原因の一つだった）と
  // 同じ轍を踏むため、当日分以外は全て消してから当日分を入れ直す（=テーブルは常に1日分だけ保持）。
  await supabaseDelete(`card_streaks?calculated_date=neq.${todayStr}`);
  await supabaseDelete(`card_streaks?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("card_streaks", rows, "oracle_id,category,format,calculated_date");
  console.log(`card_streaks 保存: ${rows.length}件（price ${rows.filter((r) => r.category === "price").length}件 / usage ${rows.filter((r) => r.category === "usage").length}件）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
