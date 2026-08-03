/**
 * card_streaks（「継続注目カード」トップページ用、db/schema.sql）を計算する。
 *
 * trending_scores（1日あたり上位10件しか保存しない・直近3日変化ベース）とは別物。
 * こちらはカード詳細ページのグラフと同じ生データ（card_cheapest_price_snapshots・
 * card_usage_stats）を全カード対象に毎日走査し、「前日比で実際に何日連続で上がり続けているか」
 * を正確に計算する。全カード分を全期間さかのぼって計算するのは無駄が大きいため、
 * STREAK_LOOKBACK_DAYS分だけ遡って走査する（この日数を超えて連続上昇し続けることは
 * 実運用上ほぼ無い前提。もし境界に達したカードがいてもstreak_daysが本来より短く出るだけで、
 * 安全側に倒れる）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-card-streaks.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const STREAK_LOOKBACK_DAYS = 60;
// 採用率のstreak計算に使う集計期間。card_usage_statsは7/30/90日の3種類を持つが、
// 日々の増減が一番はっきり出る（母数の入れ替わりが速い）7日を使う。
const USAGE_PERIOD_DAYS = 7;

const PAGE_SIZE = 1000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
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
 * 日付昇順（古い→新しい）のシリーズから、末尾を基準に「前日比で連続して上がり続けている日数」と、
 * streak開始直前の基準値・末尾（当日）の値を求める。末尾が前日以下なら streak_days=0。
 */
function computeStreak(seriesOldToNew) {
  if (seriesOldToNew.length < 2) return { streakDays: 0, baseline: null, latest: null };
  let days = 0;
  const n = seriesOldToNew.length;
  for (let i = n - 1; i > 0; i--) {
    if (seriesOldToNew[i].value > seriesOldToNew[i - 1].value) days++;
    else break;
  }
  if (days === 0) return { streakDays: 0, baseline: null, latest: null };
  return {
    streakDays: days,
    baseline: seriesOldToNew[n - 1 - days].value,
    latest: seriesOldToNew[n - 1].value,
  };
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const sinceDate = new Date(today);
  sinceDate.setDate(sinceDate.getDate() - STREAK_LOOKBACK_DAYS);
  const sinceStr = isoDate(sinceDate);

  const rows = [];

  // ── 価格（フォーマット非依存、card_cheapest_price_snapshotsは全プリント横断の最安値） ──
  const priceRows = await supabaseGet(
    `card_cheapest_price_snapshots?select=oracle_id,date,jpy_est&date=gte.${sinceStr}&jpy_est=not.is.null&order=oracle_id.asc,date.asc`,
  );
  const priceByOracle = new Map();
  for (const r of priceRows) {
    if (!priceByOracle.has(r.oracle_id)) priceByOracle.set(r.oracle_id, []);
    priceByOracle.get(r.oracle_id).push({ date: r.date, value: Number(r.jpy_est) });
  }
  for (const [oracleId, series] of priceByOracle) {
    // 末尾が今日のスナップショットでなければ（バッチ未反映等）、今日時点の連続記録とは言えないので除外
    if (series[series.length - 1].date !== todayStr) continue;
    const { streakDays, baseline, latest } = computeStreak(series);
    if (streakDays === 0 || baseline === 0) continue;
    rows.push({
      oracle_id: oracleId,
      category: "price",
      format: "ALL",
      calculated_date: todayStr,
      streak_days: streakDays,
      change_value: Math.round(((latest - baseline) / baseline) * 10000) / 100, // %
    });
  }

  // ── 採用率（フォーマットごとに別値） ──
  const usageRows = await supabaseGet(
    `card_usage_stats?select=oracle_id,format,calculated_at,usage_rate&period_days=eq.${USAGE_PERIOD_DAYS}&calculated_at=gte.${sinceStr}&order=oracle_id.asc,format.asc,calculated_at.asc`,
  );
  const usageBySeries = new Map(); // "oracle_id|format" -> series
  for (const r of usageRows) {
    const key = `${r.oracle_id}|${r.format}`;
    if (!usageBySeries.has(key)) usageBySeries.set(key, []);
    usageBySeries.get(key).push({ date: r.calculated_at, value: Number(r.usage_rate) });
  }
  for (const [key, series] of usageBySeries) {
    if (series[series.length - 1].date !== todayStr) continue;
    const { streakDays, baseline, latest } = computeStreak(series);
    if (streakDays === 0) continue;
    const [oracleId, format] = key.split("|");
    rows.push({
      oracle_id: oracleId,
      category: "usage",
      format,
      calculated_date: todayStr,
      streak_days: streakDays,
      change_value: Math.round((latest - baseline) * 100) / 100, // pt（採用率のポイント差、%換算しない）
    });
  }

  // 当日分は毎回作り直す（前日以前の古い行が残り続けないよう、当日分だけ一度消してから入れ直す）
  await supabaseDelete(`card_streaks?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("card_streaks", rows, "oracle_id,category,format,calculated_date");
  console.log(`card_streaks 保存: ${rows.length}件（price ${rows.filter((r) => r.category === "price").length}件 / usage ${rows.filter((r) => r.category === "usage").length}件）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
