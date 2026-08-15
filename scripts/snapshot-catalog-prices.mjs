/**
 * デッキ未使用カード（D1、catalog_oracles/catalog_prints）の「今日の価格」をScryfall
 * bulk dataから取得し、R2（price-history/print-history、scripts/lib/r2PriceArchive.mjs）へ
 * 追記する。以前はTCGCSV（ml/snapshot_catalog_prices_daily.py）を別データソースとして
 * 使っていたが、Scryfall bulk dataは既にsnapshot-print-prices.mjsが毎日ダウンロードしていて
 * （scripts/lib/scryfallBulk.mjs）事実上「全カード」の価格を持っているため、デッキ未使用カード
 * だけ別ソースを使う理由が無かった。1つのデータソースに寄せることで、TCGCSV/py7zr/boto3への
 * 依存を日次パイプラインから外せる（2024-02〜2026-07の履歴バックフィルという役目は既に終えている
 * ため、ml/fetch_tcgcsv_history.pyとml/snapshot_catalog_prices_daily.py自体は今後使わない）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/snapshot-catalog-prices.mjs
 */

import { ensureBulkData, buildPriceIndex, findPriceById } from "./lib/scryfallBulk.mjs";
import { mergeOraclePriceRows, mergePrintPriceRows } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const D1_DATABASE_ID = process.env.D1_DATABASE_ID ?? "a3f8dcb4-80d1-4dba-81dd-9ecd900e7623";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}
if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定してください（catalog_prints取得用）");
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

async function d1Query(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    },
  );
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`D1クエリ失敗: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body.result[0]?.results ?? [];
}

// R2書き込み（Class A、無料枠100万リクエスト/月）はカタログ規模（プリント4万件超・
// オラクル2万件超）を毎日差分チェックすると無料枠を2割程度超過する。デッキ未使用カードは
// 閲覧頻度が低く数日の鮮度遅れが実害にならないため、3日に1回だけ実行することで
// 追跡カード分（毎日更新）と合わせて無料枠に収める。
const RUN_EVERY_N_DAYS = 3;

function shouldRunToday() {
  // Unixエポックからの経過日数で判定する（曜日ベースだと年をまたぐ際のズレ等を気にしなくて済む）。
  const epochDays = Math.floor(Date.now() / 86_400_000);
  return epochDays % RUN_EVERY_N_DAYS === 0;
}

async function main() {
  if (!shouldRunToday()) {
    console.log(`今日は実行日ではありません（${RUN_EVERY_N_DAYS}日に1回のみ実行、R2書き込み無料枠対策）。終了します。`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  console.log("為替レートを取得中...");
  const rateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy&order=date.desc&limit=1");
  const rate = rateRows[0] ? Number(rateRows[0].usd_to_jpy) : null;
  if (!rate) {
    console.error("為替レートが1件も無いため中断します。scripts/snapshot-exchange-rates.mjsを先に実行してください。");
    process.exit(1);
  }

  console.log("Scryfall bulk dataを準備中...");
  await ensureBulkData();
  const index = await buildPriceIndex();

  console.log("D1（catalog_prints）を取得中...");
  const printRows = await d1Query(
    "SELECT scryfall_id, oracle_id FROM catalog_prints WHERE not_tournament_legal = 0",
  );
  console.log(`対象プリント: ${printRows.length}件`);

  const printArchiveRows = [];
  // oracle_id -> { normal: {usd, scryfallId}|null, foil: {usd, scryfallId}|null }
  const bestByOracle = new Map();
  for (const p of printRows) {
    const price = findPriceById(index, p.scryfall_id);
    const usd = price?.usd != null ? parseFloat(price.usd) : null;
    const usdFoil = price?.usd_foil != null ? parseFloat(price.usd_foil) : null;
    if (usd === null && usdFoil === null) continue;

    printArchiveRows.push({ scryfall_id: p.scryfall_id, date: today, usd, usd_foil: usdFoil });

    const entry = bestByOracle.get(p.oracle_id) ?? { normal: null, foil: null };
    if (usd != null && (!entry.normal || usd < entry.normal.usd)) entry.normal = { usd, scryfallId: p.scryfall_id };
    if (usdFoil != null && (!entry.foil || usdFoil < entry.foil.usd)) entry.foil = { usd: usdFoil, scryfallId: p.scryfall_id };
    bestByOracle.set(p.oracle_id, entry);
  }
  console.log(`価格あり: ${printArchiveRows.length}件（プリント単位）、${bestByOracle.size}件（オラクル単位）`);

  const oracleArchiveRows = [...bestByOracle.entries()]
    .filter(([, entry]) => entry.normal || entry.foil)
    .map(([oracleId, entry]) => ({
      oracle_id: oracleId,
      date: today,
      jpy_est: entry.normal ? Math.round(entry.normal.usd * rate * 100) / 100 : null,
      jpy_est_foil: entry.foil ? Math.round(entry.foil.usd * rate * 100) / 100 : null,
      scryfall_id: entry.normal?.scryfallId ?? null,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
    }));

  console.log("R2へ書き込み中...");
  if (printArchiveRows.length > 0) await mergePrintPriceRows(printArchiveRows);
  if (oracleArchiveRows.length > 0) await mergeOraclePriceRows(oracleArchiveRows);

  console.log(`\n完了: プリント単位${printArchiveRows.length}件・オラクル単位${oracleArchiveRows.length}件をR2へ書き込みました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
