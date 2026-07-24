/**
 * trending_scores（注目カードランキング、db/schema.sql）を計算する。
 * 価格・採用率それぞれの「3日前との変化」を比較する必要があるため、
 * card_price_snapshots / card_usage_stats に3日以上前のデータが無い場合は
 * 何も投入せずスキップする（0%や偽の変化率を書き込まない）。
 *
 * 取引量（volume）は無料データソースが無いため対象外（docs/spec.md 2章）。
 * category は 'price' | 'usage' の2種のみ、各フォーマットごとに変化幅の大きい順に保存する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-trending-scores.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const LOOKBACK_DAYS = 3;
const TOP_N_PER_CATEGORY = 10;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
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

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const pastDate = new Date(today);
  pastDate.setDate(pastDate.getDate() - LOOKBACK_DAYS);
  const pastStr = isoDate(pastDate);

  // ── 価格の3日変化（フォーマット非依存、oracle_id単位） ──
  const [priceToday, pricePast] = await Promise.all([
    supabaseGet(`card_price_snapshots?select=oracle_id,jpy_est&series=eq.en&date=eq.${todayStr}`),
    supabaseGet(`card_price_snapshots?select=oracle_id,jpy_est&series=eq.en&date=eq.${pastStr}`),
  ]);

  if (pricePast.length === 0) {
    console.log(
      `価格スナップショットに${pastStr}時点のデータがありません（${LOOKBACK_DAYS}日分の蓄積待ち）。trending_scoresの計算をスキップします。`
    );
    return;
  }

  const pricePastMap = new Map(pricePast.map((r) => [r.oracle_id, Number(r.jpy_est)]));
  const priceChangeByOracle = new Map(); // oracle_id -> pct
  for (const row of priceToday) {
    const past = pricePastMap.get(row.oracle_id);
    if (past == null || past === 0) continue;
    const pct = ((Number(row.jpy_est) - past) / past) * 100;
    priceChangeByOracle.set(row.oracle_id, Math.round(pct * 100) / 100);
  }

  // ── 採用率の3日変化（フォーマット×oracle_id単位） ──
  const [usageToday, usagePast] = await Promise.all([
    supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate,deck_sample_size&calculated_at=eq.${todayStr}`),
    supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${pastStr}`),
  ]);

  if (usagePast.length === 0) {
    console.log(
      `card_usage_statsに${pastStr}時点のデータがありません（${LOOKBACK_DAYS}日分の蓄積待ち）。trending_scoresの計算をスキップします。`
    );
    return;
  }

  const usagePastMap = new Map(usagePast.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));
  const usageChangeByKey = new Map(); // "format|oracle_id" -> pt
  for (const row of usageToday) {
    const key = `${row.format}|${row.oracle_id}`;
    const past = usagePastMap.get(key);
    if (past == null) continue;
    const pt = Number(row.usage_rate) - past;
    usageChangeByKey.set(key, Math.round(pt * 100) / 100);
  }

  // 前日分のtrending_scoresを取得し、各フォーマット×カテゴリの1位を継続日数計算に使う
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = isoDate(yesterday);
  const yesterdayRows = await supabaseGet(
    `trending_scores?select=oracle_id,format,category,streak_days&calculated_date=eq.${yesterdayStr}&score=not.is.null`
  );
  const yesterdayTop = new Map(); // "format|category" -> {oracle_id, streak_days} for rank1 only, approximated by first row
  for (const row of yesterdayRows) {
    const key = `${row.format}|${row.category}`;
    if (!yesterdayTop.has(key)) yesterdayTop.set(key, { oracle_id: row.oracle_id, streak_days: row.streak_days });
  }

  const formats = [...new Set(usageToday.map((r) => r.format))];
  const rows = [];

  for (const format of formats) {
    const formatOracleIds = usageToday.filter((r) => r.format === format).map((r) => r.oracle_id);

    // price category: このフォーマットで使われているカードのうち価格変化が分かるものを変化幅順に
    const priceMovers = formatOracleIds
      .map((oracleId) => ({ oracleId, pct: priceChangeByOracle.get(oracleId) }))
      .filter((r) => r.pct != null)
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
      .slice(0, TOP_N_PER_CATEGORY);

    priceMovers.forEach((r, i) => {
      const isTop = i === 0;
      const prevTop = yesterdayTop.get(`${format}|price`);
      const streak = isTop && prevTop?.oracle_id === r.oracleId ? prevTop.streak_days + 1 : 1;
      rows.push({
        oracle_id: r.oracleId,
        format,
        calculated_date: todayStr,
        price_change_3d_pct: r.pct,
        usage_change_3d_pt: null,
        volume_change_3d_pct: null,
        category: "price",
        score: r.pct,
        streak_days: streak,
      });
    });

    // usage category: 採用率の変化幅順
    const usageMovers = formatOracleIds
      .map((oracleId) => ({ oracleId, pt: usageChangeByKey.get(`${format}|${oracleId}`) }))
      .filter((r) => r.pt != null && r.pt !== 0)
      .sort((a, b) => Math.abs(b.pt) - Math.abs(a.pt))
      .slice(0, TOP_N_PER_CATEGORY);

    usageMovers.forEach((r, i) => {
      const isTop = i === 0;
      const prevTop = yesterdayTop.get(`${format}|usage`);
      const streak = isTop && prevTop?.oracle_id === r.oracleId ? prevTop.streak_days + 1 : 1;
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

  await supabaseUpsert("trending_scores", rows, "oracle_id,format,calculated_date,category");
  console.log(`trending_scores 保存: ${rows.length}件（${formats.length}フォーマット分）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
