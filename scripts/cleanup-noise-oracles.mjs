/**
 * import-full-catalog.mjsが以前set_typeを除外せずに取り込んでいたため、アートカード
 * (art_series)・トークン(token)・記念グッズ(memorabilia)・ミニゲーム(minigame)が
 * 「本物のカードと同名の別カード」としてcard_oraclesに紛れ込んでいた（例: Brainstormが
 * 実カード1件＋Art Series版1件の2オラクルとして存在）。取り込み側は修正済み（import-full-catalog.mjs
 * 参照）だが、既に登録済みの分はこのスクリプトで一括削除する。
 *
 * 判定方法: そのoracle_idの全プリントのset_typeが上記4種のみ（=普通に遊べるプリントが1つも無い）
 * なら削除対象とする。funnyは対象にしない（Unfinity以降、同じset内に使用可能カードが混在するため）。
 * 安全のため、deck_cardsから参照されているoracle_idは対象外にする（万一実際に使われていたら壊さない）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/cleanup-noise-oracles.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE } from "./lib/scryfallBulk.mjs";

const NOISE_SET_TYPES = new Set(["memorabilia", "token", "art_series", "minigame"]);

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

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await ensureBulkData();

  const oracles = await supabaseGet("card_oracles?select=oracle_id,name&order=oracle_id.asc");
  const oracleIds = new Set(oracles.map((o) => o.oracle_id));
  console.log(`card_oracles: ${oracles.length}件`);

  // oracle_id -> このオラクルの全プリントに1つでも「遊べるset_type」が存在するか
  const hasPlayablePrint = new Map();
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (!raw.oracle_id || !oracleIds.has(raw.oracle_id)) return;
    if (raw.digital) return;
    const playable = !NOISE_SET_TYPES.has(raw.set_type);
    if (playable) hasPlayablePrint.set(raw.oracle_id, true);
    else if (!hasPlayablePrint.has(raw.oracle_id)) hasPlayablePrint.set(raw.oracle_id, false);
  });

  const noiseOracles = oracles.filter((o) => hasPlayablePrint.get(o.oracle_id) === false);
  console.log(`削除候補（全プリントがアート/トークン/記念グッズ/ミニゲームのみ）: ${noiseOracles.length}件`);
  if (noiseOracles.length === 0) {
    console.log("削除対象なし");
    return;
  }
  console.log("削除候補の例（最大20件）:");
  for (const o of noiseOracles.slice(0, 20)) console.log(`  - ${o.name} (${o.oracle_id})`);

  const noiseOracleIds = noiseOracles.map((o) => o.oracle_id);

  // 安全確認: deck_cardsから参照されているものは対象から除外する
  // (in.(...)にUUIDを1000件並べるとURLが長すぎてPostgRESTがエラーになるため、小さいチャンクで問い合わせる)
  const CHECK_CHUNK = 50;
  const referenced = new Set();
  for (let i = 0; i < noiseOracleIds.length; i += CHECK_CHUNK) {
    const chunk = noiseOracleIds.slice(i, i + CHECK_CHUNK);
    const rows = await supabaseGet(`deck_cards?select=oracle_id&oracle_id=in.(${chunk.join(",")})`);
    for (const r of rows) referenced.add(r.oracle_id);
  }
  const safeToDelete = noiseOracleIds.filter((id) => !referenced.has(id));
  console.log(`deck_cardsから参照されているため除外: ${referenced.size}件`);
  console.log(`削除実行対象: ${safeToDelete.length}件`);

  if (dryRun) {
    console.log("\n--dry-run指定のため、実際の削除は行わずここで終了");
    return;
  }

  // card_oracles(oracle_id)をFK参照している全テーブル（db/schema.sql参照）を先に消してからでないと
  // 外部キー制約違反（23503）で削除できない。1回目の実行はcard_print_prices等一部を消し忘れて
  // 409 Conflictで失敗していた。
  for (let i = 0; i < safeToDelete.length; i += 50) {
    const chunk = safeToDelete.slice(i, i + 50);
    const idsParam = chunk.join(",");
    await supabaseDelete(`card_price_snapshots?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_price_snapshots_weekly?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_price_snapshots_monthly?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_print_prices?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`language_premium_stats?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`favorite_cards?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`price_alerts?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_usage_stats?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`trending_scores?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_prints?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`cards?oracle_id=in.(${idsParam})`);
    await supabaseDelete(`card_oracles?oracle_id=in.(${idsParam})`);
    console.log(`  ...${Math.min(i + 50, safeToDelete.length)}/${safeToDelete.length}件削除済み`);
  }

  console.log(`\n完了: ${safeToDelete.length}件のノイズオラクルを削除`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
