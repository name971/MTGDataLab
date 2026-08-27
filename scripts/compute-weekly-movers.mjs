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

import { monthsBetween, readPrintPriceMonths } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const LOOKBACK_DAYS = 7;
const TOP_N = 300;
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

async function loadRecentPrintPriceRows(todayStr) {
  const twoMonthsAgo = new Date(`${todayStr}T00:00:00Z`);
  twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 1);
  const months = monthsBetween(isoDate(twoMonthsAgo), todayStr);
  return readPrintPriceMonths(months);
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const pastDate = new Date(today);
  pastDate.setDate(pastDate.getDate() - LOOKBACK_DAYS);
  const pastStr = isoDate(pastDate);

  const resolvedTodayUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", todayStr);
  const resolvedPastUsageDate = await findLatestDateAtOrBefore("card_usage_stats", "calculated_at", "", pastStr);

  const rows = [];

  // 値上がりランキング（category="price"/"price_jpy"）は、2026-08-27以前はオラクル単位
  // （最安値）で計算していたが、「安い版は別にあるのに特定版だけ動いた」が見えない問題が
  // あったため、プリント×仕上げ単位の集計（旧「全プリント」カテゴリ）に一本化した
  // （ユーザー要望）。実際の計算は下のプリント単位ブロックで行う。

  // ── 採用率ランキングTop300（上昇/下降、全フォーマット横断、オラクルごとに一番変化幅が
  // 大きいフォーマットを採用）。下降版は2026-08-27追加、ユーザー要望で上昇/下降を
  // 切り替えられるようにした（category="usage"=上昇、"usage_down"=下降）。 ──
  if (resolvedTodayUsageDate && resolvedPastUsageDate) {
    const [usageToday, usagePast] = await Promise.all([
      supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedTodayUsageDate}`),
      supabaseGet(`card_usage_stats?select=format,oracle_id,usage_rate&calculated_at=eq.${resolvedPastUsageDate}`),
    ]);
    const pastMap = new Map(usagePast.map((r) => [`${r.format}|${r.oracle_id}`, Number(r.usage_rate)]));

    // pt（percentage point）差分・相対成長率どちらで全フォーマット横断ソートしても、
    // EDHREC統計の母数の性質上そもそも変動幅が大きいCommanderが常に勝ってしまい、
    // Top100がCommander一色になっていた（2026-08-27判明）。フォーマットごとに
    // 独立してTop候補を出し、ラウンドロビンで混ぜることで多様性を担保する
    // （1オラクルは最初に採用されたフォーマットのみでカウント、重複除外）。
    const MIN_PAST_USAGE_RATE = 1; // % 採用率がほぼ0だった場合の相対成長率の暴発を防ぐ下限
    function buildUsageRanking(direction) {
      const candidatesByFormat = new Map(); // format -> [{ oracleId, pt, relGrowth }]（relGrowth降順）
      for (const r of usageToday) {
        const past = pastMap.get(`${r.format}|${r.oracle_id}`);
        if (past == null) continue;
        const pt = Number(r.usage_rate) - past;
        if (direction === "up" ? pt <= 0 : pt >= 0) continue;
        const relGrowth = pt / Math.max(past, MIN_PAST_USAGE_RATE);
        if (!candidatesByFormat.has(r.format)) candidatesByFormat.set(r.format, []);
        candidatesByFormat.get(r.format).push({ oracleId: r.oracle_id, pt, relGrowth });
      }
      const sortFn = direction === "up" ? (a, b) => b.relGrowth - a.relGrowth : (a, b) => a.relGrowth - b.relGrowth;
      for (const list of candidatesByFormat.values()) list.sort(sortFn);

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
      return changes;
    }

    buildUsageRanking("up")
      .slice(0, TOP_N)
      .forEach((c, i) => {
        rows.push({
          oracle_id: c.oracleId,
          scryfall_id: null,
          category: "usage",
          format: c.format,
          finish: null,
          change_value: clampChange(c.pt),
          change_value_jpy: null,
          rank: i + 1,
          calculated_date: todayStr,
        });
      });
    buildUsageRanking("down")
      .slice(0, TOP_N)
      .forEach((c, i) => {
        rows.push({
          oracle_id: c.oracleId,
          scryfall_id: null,
          category: "usage_down",
          format: c.format,
          finish: null,
          change_value: clampChange(c.pt),
          change_value_jpy: null,
          rank: i + 1,
          calculated_date: todayStr,
        });
      });
  } else {
    console.log(`card_usage_statsに${pastStr}以前のデータがありません。採用率上昇ランキングをスキップします。`);
  }

  // ── 値上がりランキングTop300（プリント×仕上げ単位で素直に集計する。オラクル単位の
  // 最安値だと「安い版は別にあるのに特定版だけ動いた」が見えないため。foilと非foilは
  // 別の市場（別の買い手）として独立に候補にする。2026-08-27。
  // コレクターカード（プレミアム版だけに絞る旧カテゴリ）は役割が重複するため
  // 2026-08-27に廃止した。 ──
  {
    const [currentPrices, rateRows] = await Promise.all([
      supabaseGet(`card_print_current_prices?select=scryfall_id,oracle_id,usd,usd_foil`),
      supabaseGet(`exchange_rates?select=usd_to_jpy&order=date.desc&limit=1`),
    ]);
    const usdToJpy = Number(rateRows[0]?.usd_to_jpy ?? 0);
    if (usdToJpy > 0 && currentPrices.length > 0) {
      const oracleByScryfallId = new Map();
      for (const p of currentPrices) oracleByScryfallId.set(p.scryfall_id, p.oracle_id);

      const printRows = await loadRecentPrintPriceRows(todayStr);
      let latestPrintDate = null;
      let pastPrintDate = null;
      for (const r of printRows) {
        if (r.date <= todayStr && (!latestPrintDate || r.date > latestPrintDate)) latestPrintDate = r.date;
        if (r.date <= pastStr && (!pastPrintDate || r.date > pastPrintDate)) pastPrintDate = r.date;
      }

      if (latestPrintDate && pastPrintDate) {
        // 1プリントにつき1日1件を単純比較すると、業者側の一時的な入力ミス等による
        // 「その日だけ$0.2」のような単発の異常値をそのまま暴騰として拾ってしまう
        // （Tundraで実際に発生、2026-08-27判明: 通常$3000のところ08-20だけ$0.2）。
        // 前後3日以内の値を集めて中央値を取り、2点以上揃わなければ判定不能として
        // スキップすることで、単発の異常値1点だけに引っ張られないようにする。
        const rowsByPrint = new Map();
        for (const r of printRows) {
          if (!rowsByPrint.has(r.scryfall_id)) rowsByPrint.set(r.scryfall_id, []);
          rowsByPrint.get(r.scryfall_id).push(r);
        }
        const WINDOW_DAYS = 3;
        function robustPriceAt(printRowsForId, targetDateStr, finish) {
          const target = new Date(`${targetDateStr}T00:00:00Z`).getTime();
          const values = [];
          for (const r of printRowsForId) {
            const v = finish === "foil" ? r.usd_foil : r.usd;
            if (v == null) continue;
            const d = new Date(`${r.date}T00:00:00Z`).getTime();
            if (Math.abs(d - target) <= WINDOW_DAYS * 86400000) values.push(Number(v));
          }
          if (values.length < 2) return null;
          values.sort((a, b) => a - b);
          const mid = Math.floor(values.length / 2);
          return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
        }

        // 1プリントにつき最大2件（finish列で区別）、値上がりランキング（category="price"）
        // として保存する。
        const allPrintChanges = [];
        for (const [scryfallId, printRowsForId] of rowsByPrint) {
          const oracleId = oracleByScryfallId.get(scryfallId);
          if (!oracleId) continue;
          for (const finish of ["nonfoil", "foil"]) {
            const cur = robustPriceAt(printRowsForId, latestPrintDate, finish);
            const prev = robustPriceAt(printRowsForId, pastPrintDate, finish);
            if (cur == null || prev == null || prev === 0) continue;
            const pct = ((cur - prev) / prev) * 100;
            if (pct <= 0) continue;
            const jpyEst = cur * usdToJpy;
            const jpyDiff = (cur - prev) * usdToJpy;
            allPrintChanges.push({ scryfallId, oracleId, finish, pct, jpyEst, jpyDiff });
          }
        }
        const allPrintByPct = [...allPrintChanges].sort((a, b) => b.pct - a.pct);
        allPrintByPct.slice(0, TOP_N).forEach((c, i) => {
          rows.push({
            oracle_id: c.oracleId,
            scryfall_id: c.scryfallId,
            category: "price",
            format: null,
            finish: c.finish,
            change_value: clampChange(c.pct),
            change_value_jpy: clampChange(c.jpyEst),
            rank: i + 1,
            calculated_date: todayStr,
          });
        });
        const allPrintByJpy = [...allPrintChanges].sort((a, b) => b.jpyDiff - a.jpyDiff);
        allPrintByJpy.slice(0, TOP_N).forEach((c, i) => {
          rows.push({
            oracle_id: c.oracleId,
            scryfall_id: c.scryfallId,
            category: "price_jpy",
            format: null,
            finish: c.finish,
            // change_value_jpyを「現在価格」の表示に使う（オラクル単位のcard_current_prices
            // に相当するプリント単位の別ソースが無いため）。change_valueの方はランキング
            // 指標そのもの（pctではなく円建て変化額）を持つ。
            change_value: clampChange(c.jpyDiff),
            change_value_jpy: clampChange(c.jpyEst),
            rank: i + 1,
            calculated_date: todayStr,
          });
        });
      } else {
        console.log(`プリント価格履歴に${pastStr}以前のデータがありません。プリント単位のランキングをスキップします。`);
      }
    } else {
      console.log("為替レートまたはプリント現在価格が無いため、プリント単位のランキングをスキップします。");
    }
  }

  await supabaseDelete(`weekly_movers?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("weekly_movers", rows, "category,calculated_date,rank");
  console.log(`weekly_movers 保存: ${rows.length}件`);

  // 保持ポリシー: アプリは最新calculated_date分しか読まないため、それより古い行は不要
  await supabaseDelete(`weekly_movers?calculated_date=lt.${todayStr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
