/**
 * 週次ランキングページ（/rankings/trending）用の「値上がりTop100」「採用率上昇Top100」を
 * weekly_moversテーブル（db/schema.sql）に計算・保存する。compute-trending-scores.mjsの
 * 3日差分ロジック（トップページの小さな注目カード表示用）とは別に、7日差分・Top100件を
 * 対象にする専用バッチ。日次実行で「直近7日間の変化」を毎日ローリング更新する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/compute-weekly-movers.mjs
 */

import { monthsBetween, readOraclePriceMonths } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const LOOKBACK_DAYS = 7;
const TOP_N = 100;
const NUMERIC_8_2_MAX = 999999.99; // 極端な激安カードの暴騰でnumeric overflowしないようクランプする

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function clampChange(value) {
  return Math.max(-NUMERIC_8_2_MAX, Math.min(NUMERIC_8_2_MAX, value));
}

const PAGE_SIZE = 1000;

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

async function supabaseUpsert(table, rows, onConflict) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function findLatestDateAtOrBefore(table, dateColumn, extraFilter, targetDate) {
  const rows = await supabaseGet(
    `${table}?select=${dateColumn}&${extraFilter}&${dateColumn}=lte.${targetDate}&order=${dateColumn}.desc&limit=1`,
  );
  return rows[0]?.[dateColumn] ?? null;
}

// 価格履歴はR2（price-history、月次NDJSON.gz）にしか無い（compute-trending-scores.mjsと同じ理由）
async function loadRecentOraclePriceRows(todayStr) {
  const twoMonthsAgo = new Date(`${todayStr}T00:00:00Z`);
  twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 1);
  const months = monthsBetween(isoDate(twoMonthsAgo), todayStr);
  return readOraclePriceMonths(months);
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const pastDate = new Date(today);
  pastDate.setDate(pastDate.getDate() - LOOKBACK_DAYS);
  const pastStr = isoDate(pastDate);

  const priceRows = await loadRecentOraclePriceRows(todayStr);
  let latestPriceDate = null;
  let pastPriceDate = null;
  for (const r of priceRows) {
    if (r.date <= todayStr && (!latestPriceDate || r.date > latestPriceDate)) latestPriceDate = r.date;
    if (r.date <= pastStr && (!pastPriceDate || r.date > pastPriceDate)) pastPriceDate = r.date;
  }

  const resolvedTodayUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", todayStr);
  const resolvedPastUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", pastStr);

  const rows = [];

  // ── 値上がりTop100（フォーマット非依存、オラクル単位の最安値ベース） ──
  if (latestPriceDate && pastPriceDate) {
    const pastByOracle = new Map(); // oracle_id -> { jpy, scryfallId }
    for (const r of priceRows) {
      if (r.date === pastPriceDate && r.jpy_est != null) {
        pastByOracle.set(r.oracle_id, { jpy: Number(r.jpy_est), scryfallId: r.scryfall_id ?? null });
      }
    }
    // Black Lotus等、プリント間の価格差が極端なオラクルは、一番安いプリントが品切れ等で
    // 買えなくなっただけで「最安値」が別の（ずっと高い）プリントに切り替わり、実際には
    // 誰も高く買っていないのにオラクル価格が跳ね上がって見えることがある。R2価格履歴の
    // scryfall_id（その日どのプリントが最安だったかの監査用カラム、docs/spec.md参照）を
    // 突き合わせ、最安プリントが変わった かつ 変化幅が尋常でない（PRINT_SWAP_PCT_THRESHOLD超）
    // 場合だけ「プリント切り替えの疑いあり」として除外する（同じプリントのままの値上がりや、
    // プリントが変わっても小幅な差は本物の値動きとして許容する）。
    const PRINT_SWAP_PCT_THRESHOLD = 100;
    const changes = [];
    for (const r of priceRows) {
      if (r.date !== latestPriceDate || r.jpy_est == null) continue;
      const past = pastByOracle.get(r.oracle_id);
      if (!past || past.jpy === 0) continue;
      const pct = ((Number(r.jpy_est) - past.jpy) / past.jpy) * 100;
      if (pct <= 0) continue; // 値上がりのみ対象（値下がりは別軸なので今回は扱わない）
      const scryfallId = r.scryfall_id ?? null;
      const printSwapped = scryfallId != null && past.scryfallId != null && scryfallId !== past.scryfallId;
      if (printSwapped && pct >= PRINT_SWAP_PCT_THRESHOLD) continue;
      changes.push({ oracleId: r.oracle_id, pct, jpyDiff: Number(r.jpy_est) - past.jpy });
    }
    changes.sort((a, b) => b.pct - a.pct);
    changes.slice(0, TOP_N).forEach((c, i) => {
      rows.push({
        oracle_id: c.oracleId,
        category: "price",
        format: null,
        change_value: clampChange(c.pct),
        change_value_jpy: clampChange(c.jpyDiff),
        rank: i + 1,
        calculated_date: todayStr,
      });
    });
  } else {
    console.log(`価格履歴に${pastStr}以前のデータがありません。値上がりランキングをスキップします。`);
  }

  // ── 採用率上昇Top100（全フォーマット横断、オラクルごとに一番変化幅が大きいフォーマットを採用） ──
  if (resolvedTodayUsageDate && resolvedPastUsageDate) {
    const [usageToday, usagePast] = await Promise.all([
      supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedTodayUsageDate}`),
      supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedPastUsageDate}`),
    ]);
    // pt（percentage point）差分・相対成長率どちらで全フォーマット横断ソートしても、
    // EDHREC統計の母数の性質上そもそも変動幅が大きいCommanderが常に勝ってしまい、
    // Top100がCommander一色になっていた（2026-08-27判明）。フォーマットごとに
    // 独立してTop候補を出し、ラウンドロビンで混ぜることで多様性を担保する
    // （1オラクルは最初に採用されたフォーマットのみでカウント、重複除外）。
    const MIN_PAST_USAGE_RATE = 1; // % 採用率がほぼ0だった場合の相対成長率の暴発を防ぐ下限
    const pastMap = new Map(usagePast.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));
    const candidatesByFormat = new Map(); // format -> [{ oracleId, pt, relGrowth }]（relGrowth降順）
    for (const r of usageToday) {
      const past = pastMap.get(`${r.format}|${r.oracle_id}`);
      if (past == null) continue;
      const pt = Number(r.usage_rate) - past;
      if (pt <= 0) continue;
      const relGrowth = pt / Math.max(past, MIN_PAST_USAGE_RATE);
      if (!candidatesByFormat.has(r.format)) candidatesByFormat.set(r.format, []);
      candidatesByFormat.get(r.format).push({ oracleId: r.oracle_id, pt, relGrowth });
    }
    for (const list of candidatesByFormat.values()) list.sort((a, b) => b.relGrowth - a.relGrowth);

    const formatQueues = [...candidatesByFormat.entries()].map(([format, list]) => ({ format, list, idx: 0 }));
    const seenOracle = new Set();
    const changes = [];
    while (changes.length < TOP_N && formatQueues.some((q) => q.idx < q.list.length)) {
      for (const q of formatQueues) {
        while (q.idx < q.list.length && seenOracle.has(q.list[q.idx].oracleId)) q.idx++;
        if (q.idx >= q.list.length) continue;
        const c = q.list[q.idx++];
        seenOracle.add(c.oracleId);
        changes.push({ oracleId: c.oracleId, format: q.format, pt: c.pt, relGrowth: c.relGrowth });
        if (changes.length >= TOP_N) break;
      }
    }
    changes.slice(0, TOP_N).forEach((c, i) => {
      rows.push({
        oracle_id: c.oracleId,
        category: "usage",
        format: c.format,
        change_value: clampChange(c.pt),
        change_value_jpy: null,
        rank: i + 1,
        calculated_date: todayStr,
      });
    });
  } else {
    console.log(`card_usage_statsに${pastStr}以前のデータがありません。採用率上昇ランキングをスキップします。`);
  }

  await supabaseDelete(`weekly_movers?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("weekly_movers", rows, "oracle_id,category,calculated_date");
  console.log(`weekly_movers 保存: ${rows.length}件`);

  // 保持ポリシー: アプリは最新calculated_date分しか読まないため、それより古い行は不要
  await supabaseDelete(`weekly_movers?calculated_date=lt.${todayStr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
