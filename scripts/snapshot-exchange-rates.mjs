/**
 * Frankfurter API（為替レート、APIキー不要）からUSD/EUR→JPYレートを取得し、
 * exchange_rates（db/schema.sql）に本日分として保存する。
 *
 * card_print_prices・card_cheapest_price_snapshots等のUSD建て価格をJPYに換算する際、
 * このテーブルの当日分レートが無いと換算そのものができず、価格表示が丸ごと欠落する
 * （src/lib/dbCardPrintPrices.tsで実際に発生した）。旧snapshot-prices.mjsが
 * card_price_snapshots（未使用テーブル、削除済み）と一緒にこの為替レート取得も
 * 担っていたが、そちらの削除時に巻き添えで為替レート更新も止まっていたため、
 * 為替レート取得だけを独立したスクリプトとして切り出す。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/snapshot-exchange-rates.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

async function supabaseUpsert(table, rows, conflictColumn) {
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
  const today = new Date().toISOString().slice(0, 10);

  const usdRes = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
  const usdData = await usdRes.json();
  const usdToJpy = usdData.rates.JPY;

  const eurRes = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=JPY");
  const eurData = await eurRes.json();
  const eurToJpy = eurData.rates.JPY;

  await supabaseUpsert("exchange_rates", [{ date: today, usd_to_jpy: usdToJpy, eur_to_jpy: eurToJpy }], "date");
  console.log(`為替レート保存: ${today} USD/JPY=${usdToJpy} EUR/JPY=${eurToJpy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
