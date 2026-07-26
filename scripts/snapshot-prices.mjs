/**
 * cardsテーブルに登録済みの代表プリント（en/ja）の現在価格をScryfallのバルクデータから取得し、
 * exchange_rates・card_price_snapshots（db/schema.sql）に本日分として保存する。
 * 日次バッチの雛形（スケジュール自体は未確定、docs/spec.md参照）。
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/snapshot-prices.mjs
 */

import { ensureBulkData, loadIndex, findPriceById } from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000; // PostgRESTのデフォルト最大行数（db-max-rows）に合わせてページングする

async function supabaseSelect(table, query) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`${table} select failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function supabaseUpsert(table, rows, conflictColumn) {
  if (rows.length === 0) return;
  // 一度に大量の行を送るとペイロードが大きくなりすぎるため分割して送る
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

  // 1. 為替レート取得＋保存
  const usdRes = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
  const usdData = await usdRes.json();
  const usdToJpy = usdData.rates.JPY;
  const eurRes = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=JPY");
  const eurData = await eurRes.json();
  const eurToJpy = eurData.rates.JPY;
  await supabaseUpsert("exchange_rates", [{ date: today, usd_to_jpy: usdToJpy, eur_to_jpy: eurToJpy }], "date");
  console.log(`為替レート保存: ${today} USD/JPY=${usdToJpy}`);

  // 2. Scryfallバルクデータを用意（1枚ずつAPIを叩かず、ローカルのインデックスから引く）
  await ensureBulkData();
  const index = await loadIndex();

  // 3. cardsテーブルの登録済みプリント一覧を取得
  // order句が無いとページング中の並び順が不安定になり、直前に大量の書き込みがあった直後などは
  // 行の物理的な並びが揺れて一部の行がページ取得から漏れることがある（実際にFable of the
  // Mirror-Breakerで発生: 対象カード数は一致するのにこの1件だけスナップショットが作られなかった）。
  // 安定した一意キーであるscryfall_idで並べる。
  const cards = await supabaseSelect("cards", "select=scryfall_id,oracle_id,lang,name&order=scryfall_id.asc");
  console.log(`対象カード: ${cards.length}件`);

  const snapshots = [];
  let ok = 0;
  let notInBulk = 0;

  for (const card of cards) {
    const price = findPriceById(index, card.scryfall_id);
    if (!price) {
      console.error(`✗ ${card.name} (${card.lang}): バルクデータに無し（廃止プリント等）`);
      notInBulk++;
      continue;
    }

    const usd = price.usd ? parseFloat(price.usd) : null;
    const eur = price.eur ? parseFloat(price.eur) : null;
    const jpyEst = usd !== null ? Math.round(usd * usdToJpy * 100) / 100 : null;

    snapshots.push({
      oracle_id: card.oracle_id,
      series: card.lang === "ja" ? "ja" : "en",
      scryfall_id: card.scryfall_id,
      date: today,
      usd,
      eur,
      jpy_est: jpyEst,
    });
    ok++;
  }

  // 同じoracle_id+seriesのcards行が複数存在するケース（過去のインポートの重複等）があるため、
  // 1回のUPSERT内で(oracle_id,series,date)が重複しないよう名寄せしてから送る
  const dedupedSnapshots = [
    ...new Map(snapshots.map((s) => [`${s.oracle_id}|${s.series}`, s])).values(),
  ];

  if (dedupedSnapshots.length > 0) {
    await supabaseUpsert("card_price_snapshots", dedupedSnapshots, "oracle_id,series,date");
  }

  console.log(
    `\n完了: ${dedupedSnapshots.length}件保存（重複除去前${ok}件）、${notInBulk}件バルクデータに無し`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
