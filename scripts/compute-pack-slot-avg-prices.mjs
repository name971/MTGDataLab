/**
 * pack_slot_cards（MTGJSONブースターシートのカード構成・ウェイト、scripts/import-pack-slot-cards.mjsが
 * 一度だけ投入、db/schema.sql）× card_print_prices（全プリントの日次価格履歴）を突き合わせ、
 * 元のsamplePackData.ts（scripts/generate-pack-data.mjs）と同じ「カード単位の出現ウェイト付き
 * 平均」でスロット単価を毎日計算し直し、pack_slot_avg_prices（db/schema.sql）に保存する。
 * カード構成は静的（新セット追加時のみ再投入）、価格だけがこのスクリプトで日次追従する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-pack-slot-avg-prices.mjs
 */

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
  if (rows.length === 0) return;
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

async function resolveUsdToJpy(today) {
  const rows = await supabaseGet(`exchange_rates?date=eq.${today}&select=usd_to_jpy`);
  if (rows[0]) return Number(rows[0].usd_to_jpy);
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
  const data = await res.json();
  return data.rates.JPY;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const usdToJpy = await resolveUsdToJpy(today);
  console.log(`為替レート: 1USD=${usdToJpy}円`);

  console.log("ブースターシートのカード構成を取得中...");
  const slotCards = await supabaseGet("pack_slot_cards?select=set_code,product_type,slot_name,scryfall_id,weight,foil");
  console.log(`${slotCards.length}行`);
  if (slotCards.length === 0) {
    console.log("pack_slot_cardsが空です。先にscripts/import-pack-slot-cards.mjsを実行してください。");
    return;
  }

  // UUIDを1000件そのまま.in()に入れるとURLが長すぎてPostgRESTが400を返す（このプロジェクトで
  // 何度か踏んだ既知の問題、Island等の700件超プリントで顕在化）。小さいチャンクに分ける。
  const ID_CHUNK = 150;
  const scryfallIds = [...new Set(slotCards.map((r) => r.scryfall_id))];
  console.log(`対象プリント: ${scryfallIds.length}件の価格を取得中...`);
  const priceByScryfallId = new Map();
  for (let i = 0; i < scryfallIds.length; i += ID_CHUNK) {
    const chunk = scryfallIds.slice(i, i + ID_CHUNK);
    const rows = await supabaseGet(
      `card_print_prices?scryfall_id=in.(${chunk.join(",")})&select=scryfall_id,prices,prices_foil`,
    );
    for (const r of rows) priceByScryfallId.set(r.scryfall_id, r);
  }

  // key: `${set_code}|${product_type}|${slot_name}` -> { weightedSum, totalWeight, matchedWeight }
  // 日次パイプラインの実行順序次第で「今日」の価格がまだ入っていないことがある
  // （このプリントのsnapshotがまだ来ていない等）ため、厳密に today のキーだけを見るのではなく、
  // プリントごとに一番新しい日付のものを使う。
  function latestPrice(priceMap) {
    if (!priceMap) return null;
    const dates = Object.keys(priceMap).sort();
    const latestDate = dates.at(-1);
    return latestDate ? priceMap[latestDate] : null;
  }

  const stats = new Map();
  for (const row of slotCards) {
    const key = `${row.set_code}|${row.product_type}|${row.slot_name}`;
    const s = stats.get(key) ?? { weightedSum: 0, totalWeight: 0, matchedWeight: 0 };
    const weight = Number(row.weight);
    s.totalWeight += weight;

    const priceRow = priceByScryfallId.get(row.scryfall_id);
    const usd = row.foil ? latestPrice(priceRow?.prices_foil) : latestPrice(priceRow?.prices);
    if (typeof usd === "number") {
      s.weightedSum += usd * weight;
      s.matchedWeight += weight;
    }
    stats.set(key, s);
  }

  const rows = [...stats.entries()].map(([key, s]) => {
    const [set_code, product_type, slot_name] = key.split("|");
    const avgPriceUsd = s.matchedWeight > 0 ? s.weightedSum / s.matchedWeight : 0;
    return {
      set_code,
      product_type,
      slot_name,
      avg_price_jpy: Math.round(avgPriceUsd * usdToJpy * 100) / 100,
      match_rate: s.totalWeight > 0 ? Math.round((s.matchedWeight / s.totalWeight) * 10000) / 10000 : 0,
      calculated_at: today,
    };
  });

  console.log(`${rows.length}件（セット×商品種別×スロット）の平均価格を保存中...`);
  await supabaseUpsert("pack_slot_avg_prices", rows, "set_code,product_type,slot_name,calculated_at");
  console.log("完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
