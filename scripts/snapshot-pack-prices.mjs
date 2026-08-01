/**
 * pack_slot_definitions（db/schema.sql、パックEV対象として既に登録済みのセット一覧）にある
 * 各セット×商品種別について、TCGCSV（tcgcsv.com、TCGplayerのカテゴリ/グループ/商品/価格データを
 * 認証不要で日次公開している）からパック単品の実勢価格（USD）を取得し、
 * sealed_price_snapshots（db/schema.sql）に日次で追記する。パック画像URLはpack_productsに保存
 * （めったに変わらないため、価格と違って毎日は上書きしない設計）。
 *
 * scripts/generate-pack-data.mjs（静的ファイル生成、廃止予定）のTCGCSV取得ロジックを
 * 日次バッチ用に切り出したもの。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/snapshot-pack-prices.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; jp-mtgstocks/0.1)" };
const TCGCSV_MAGIC_CATEGORY_ID = 1;

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
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

async function fetchExchangeRate() {
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
  const data = await res.json();
  return data.rates.JPY;
}

let tcgcsvGroupsCache = null;
async function fetchTcgcsvGroups() {
  if (tcgcsvGroupsCache) return tcgcsvGroupsCache;
  const res = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/groups`, {
    headers: FETCH_HEADERS,
  });
  const data = await res.json();
  tcgcsvGroupsCache = data.results;
  return tcgcsvGroupsCache;
}

/**
 * TCGCSVからそのセットの「Play/Collector Booster Pack」単品のmarketPrice（実勢価格、USD）を取得する。
 * グループはabbreviationがセットコードと完全一致するもの（"Commander: X"等の派生グループの
 * 誤取得を防ぐ）。見つからなければnullを返す。
 */
async function fetchPackMarketInfo(setCode, productTypeKey) {
  const groups = await fetchTcgcsvGroups();
  const group = groups.find((g) => g.abbreviation?.toLowerCase() === setCode.toLowerCase());
  if (!group) return null;

  const nameRegex = productTypeKey === "collector" ? /collector booster pack/i : /play booster pack/i;

  const prodRes = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/${group.groupId}/products`, {
    headers: FETCH_HEADERS,
  });
  const prodData = await prodRes.json();
  const pack = prodData.results.find((p) => nameRegex.test(p.name) && !/sleeved|display/i.test(p.name));
  if (!pack) return null;

  const priceRes = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/${group.groupId}/prices`, {
    headers: FETCH_HEADERS,
  });
  const priceData = await priceRes.json();
  const price = priceData.results.find((r) => r.productId === pack.productId);
  const priceUsd = price?.marketPrice ?? price?.midPrice ?? null;
  if (priceUsd === null) return null;
  return { priceUsd, imageUrl: pack.imageUrl ?? null };
}

const DB_TYPE_TO_KEY = { play_booster: "play", collector_booster: "collector" };

async function main() {
  console.log("対象セット一覧を取得中...");
  const slotRows = await supabaseGet("pack_slot_definitions?select=set_code,product_type");
  const targets = [...new Set(slotRows.map((r) => `${r.set_code}|${r.product_type}`))].map((k) => {
    const [set_code, product_type] = k.split("|");
    return { set_code, product_type };
  });
  console.log(`対象: ${targets.length}件（セット×商品種別）`);

  const usdToJpy = await fetchExchangeRate();
  const today = new Date().toISOString().slice(0, 10);

  const priceRows = [];
  const productRows = [];
  let found = 0;
  for (const { set_code, product_type } of targets) {
    const key = DB_TYPE_TO_KEY[product_type];
    if (!key) continue;
    const info = await fetchPackMarketInfo(set_code, key);
    if (!info) {
      console.log(`✗ ${set_code} [${product_type}]: TCGCSVで実勢価格が見つからず`);
      continue;
    }
    priceRows.push({
      set_code,
      product_type,
      date: today,
      usd_market_price: info.priceUsd,
      jpy_est: Math.round(info.priceUsd * usdToJpy * 100) / 100,
    });
    if (info.imageUrl) {
      productRows.push({ set_code, product_type, pack_image_url: info.imageUrl });
    }
    found++;
  }

  await supabaseUpsert("sealed_price_snapshots", priceRows, "set_code,product_type,date");
  await supabaseUpsert("pack_products", productRows, "set_code,product_type");
  console.log(`\n完了: ${found}/${targets.length}件のパック価格を保存`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
