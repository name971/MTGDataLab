/**
 * card_print_current_prices（Postgres、各プリントの「今の価格」キャッシュ、
 * scripts/snapshot-print-prices.mjsが日次更新）から、オラクル単位で「今、全プリント中の
 * 最安値」を計算し、2箇所に書き込む:
 *   1. card_current_prices（Postgres）: 「今の価格」だけを1オラクル1行で持つキャッシュ。
 *      カード詳細ページのメイン価格等、頻繁に読まれる箇所はここを見る。
 *   2. price-history（Cloudflare R2、月次NDJSON.gz、scripts/lib/r2PriceArchive.mjs）: 今日分を
 *      1日ぶんだけ追記する日次履歴（価格推移グラフ用）。以前はCloudflare D1に書いていたが、
 *      D1無料枠の日次読み書き行数上限に達したため、リクエスト数課金のR2へ移行した。
 *
 * 以前はcard_print_prices（Postgres、プリント単位JSONB全履歴）を毎回丸ごとスキャンして
 * 過去に遡って全期間を再計算する設計だったが、card_print_current_prices自体が既に
 * 「各プリントの最新価格」を保持しているため、その必要が無くなった（DB容量超過対応）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/compute-cheapest-price-snapshots.mjs
 */

import { mergeOraclePriceRows, monthsBetween, readOraclePriceMonths, writeRecentPriceChanges } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
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
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  console.log("為替レートを取得中...");
  const rateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy&order=date.desc&limit=1");
  const rate = rateRows[0] ? Number(rateRows[0].usd_to_jpy) : null;
  if (!rate) {
    console.error("為替レートが1件も無いため中断します。scripts/snapshot-exchange-rates.mjsを先に実行してください。");
    process.exit(1);
  }
  console.log(`使用するレート: ${rateRows[0].date} 時点 ${rate}円/$`);

  console.log("使用不可プリントの一覧を取得中...");
  const notLegalRows = await supabaseGet("card_prints?not_tournament_legal=eq.true&select=scryfall_id");
  const notTournamentLegalIds = new Set(notLegalRows.map((r) => r.scryfall_id));
  console.log(`${notTournamentLegalIds.size}件が使用不可プリント（最安値集計から除外）`);

  console.log("プリント単位の現在価格キャッシュ（card_print_current_prices）を取得中...");
  const printRows = await supabaseGet(
    "card_print_current_prices?select=scryfall_id,oracle_id,usd,usd_foil",
  );
  console.log(`${printRows.length}件のプリント現在価格を走査`);

  // オラクル単位で最安値（通常・Foilそれぞれ）を求める
  const bestByOracle = new Map(); // oracle_id -> { normal: {usd, scryfallId}|null, foil: {...}|null }
  for (const row of printRows) {
    if (notTournamentLegalIds.has(row.scryfall_id)) continue;
    const entry = bestByOracle.get(row.oracle_id) ?? { normal: null, foil: null };
    if (row.usd != null && (!entry.normal || row.usd < entry.normal.usd)) {
      entry.normal = { usd: Number(row.usd), scryfallId: row.scryfall_id };
    }
    if (row.usd_foil != null && (!entry.foil || row.usd_foil < entry.foil.usd)) {
      entry.foil = { usd: Number(row.usd_foil), scryfallId: row.scryfall_id };
    }
    bestByOracle.set(row.oracle_id, entry);
  }

  const cacheRows = [];
  const archiveRows = [];
  for (const [oracleId, entry] of bestByOracle) {
    if (!entry.normal && !entry.foil) continue;
    const jpyEst = entry.normal ? Math.round(entry.normal.usd * rate * 100) / 100 : null;
    const jpyEstFoil = entry.foil ? Math.round(entry.foil.usd * rate * 100) / 100 : null;
    cacheRows.push({
      oracle_id: oracleId,
      date: today,
      scryfall_id: entry.normal?.scryfallId ?? null,
      usd: entry.normal?.usd ?? null,
      jpy_est: jpyEst,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
      usd_foil: entry.foil?.usd ?? null,
      jpy_est_foil: jpyEstFoil,
    });
    archiveRows.push({
      oracle_id: oracleId,
      date: today,
      jpy_est: jpyEst,
      jpy_est_foil: jpyEstFoil,
      scryfall_id: entry.normal?.scryfallId ?? null,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
    });
  }

  console.log(`${cacheRows.length}件（オラクル単位）の最安値を計算完了`);

  // R2書き込み（GET+PUTで1オラクルあたり2リクエスト）は無料枠（Class A書き込み100万件/月）に
  // 対して全件（2〜3万件）を毎日書くと直撃するため、プリント側（snapshot-print-prices.mjs）と
  // 同様に前日から値が変わったオラクルだけを対象にする（差分書き込み）。
  console.log("前日分の現在価格キャッシュ（card_current_prices）を取得中...");
  const prevCurrentRows = await supabaseGet("card_current_prices?select=oracle_id,jpy_est,jpy_est_foil");
  const prevByOracle = new Map(prevCurrentRows.map((r) => [r.oracle_id, { jpy_est: r.jpy_est, jpy_est_foil: r.jpy_est_foil }]));
  const changedArchiveRows = archiveRows.filter((r) => {
    const prev = prevByOracle.get(r.oracle_id);
    return !prev || r.jpy_est !== prev.jpy_est || r.jpy_est_foil !== prev.jpy_est_foil;
  });
  console.log(`  前日比で変化あり: ${changedArchiveRows.length}/${archiveRows.length}件`);

  console.log("Postgres（card_current_prices）を更新中...");
  await supabaseUpsert("card_current_prices", cacheRows, "oracle_id");

  console.log("R2（price-history）へ今日分の差分を書き込み中...");
  if (changedArchiveRows.length > 0) await mergeOraclePriceRows(changedArchiveRows);

  // ランキング/トレンドページ用に、全オラクル分の「直近の価格系列＋3日前比の変化率」を
  // 1ファイルにまとめて書いておく（src/lib/dbCardRanking.ts等が、オラクルごとに個別ファイルを
  // 読む代わりにこれを1回のGetObjectで読むことで、100件規模でもラウンドトリップが1回で済む
  // ようにする）。トレンドページ（src/lib/dbTrendingRanking.ts）が直近1/3/6日の推移一致を
  // 見るため、3日前比の数値だけでなく直近7日分の系列も含める。
  console.log("直近7日分の価格履歴を読み込んで変化率・系列を計算中...");
  const RECENT_SERIES_DAYS = 7;
  const pastDate = new Date(`${today}T00:00:00Z`);
  pastDate.setUTCDate(pastDate.getUTCDate() - RECENT_SERIES_DAYS);
  const seriesStartStr = pastDate.toISOString().slice(0, 10);
  const pctPastDate = new Date(`${today}T00:00:00Z`);
  pctPastDate.setUTCDate(pctPastDate.getUTCDate() - 3);
  const pctPastDateStr = pctPastDate.toISOString().slice(0, 10);
  const recentMonths = monthsBetween(seriesStartStr, today);
  const recentRows = await readOraclePriceMonths(recentMonths);
  const seriesByOracle = new Map();
  for (const r of recentRows) {
    if (r.jpy_est == null || r.date < seriesStartStr || r.date > today) continue;
    if (!seriesByOracle.has(r.oracle_id)) seriesByOracle.set(r.oracle_id, []);
    seriesByOracle.get(r.oracle_id).push({ date: r.date, jpy: Number(r.jpy_est) });
  }
  const pastPriceByOracle = new Map();
  for (const [oracleId, series] of seriesByOracle) {
    let best = null;
    for (const p of series) {
      if (p.date > pctPastDateStr) continue;
      if (!best || p.date > best.date) best = p;
    }
    if (best) pastPriceByOracle.set(oracleId, best);
  }
  const priceChangeRows = archiveRows
    .filter((r) => r.jpy_est != null)
    .map((r) => {
      const past = pastPriceByOracle.get(r.oracle_id);
      const priceChange3dPct =
        past && past.jpy !== 0 ? Math.round(((r.jpy_est - past.jpy) / past.jpy) * 10000) / 100 : null;
      const series = [...(seriesByOracle.get(r.oracle_id) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
      return {
        oracle_id: r.oracle_id,
        date: r.date,
        jpy_est: r.jpy_est,
        jpy_est_foil: r.jpy_est_foil,
        scryfall_id: r.scryfall_id,
        scryfall_id_foil: r.scryfall_id_foil,
        price_change_3d_pct: priceChange3dPct,
        recent_series: series,
      };
    });
  await writeRecentPriceChanges(priceChangeRows);
  console.log(`  R2（price-changes/latest.ndjson.gz）へ書き込み: ${priceChangeRows.length}件`);

  console.log(`\n完了: 現在価格キャッシュ${cacheRows.length}件更新、R2へ差分${changedArchiveRows.length}件書き込み`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
