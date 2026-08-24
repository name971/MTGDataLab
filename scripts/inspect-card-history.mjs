/**
 * 指定オラクルのカード単位価格履歴（oracle-history/{oracleId}.ndjson.gz）を表示し、
 * 使用不可版プリント（not_tournament_legal）が紛れ込んでいないか検査する調査用ツール。
 * 2026-08-24、Time Walk等でこの種の混入が月次ファイルには無いのにカード単位ファイルにだけ
 * 残っているケースを都度その場limitのスクリプトで調べていたため、使い回せる形にした。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/inspect-card-history.mjs <oracleId> [--tail=N]
 */

import { readOracleCardFile } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const oracleId = process.argv[2];
if (!oracleId) {
  console.error("使い方: node scripts/inspect-card-history.mjs <oracleId> [--tail=N]");
  process.exit(1);
}
const tailArg = process.argv.find((a) => a.startsWith("--tail="));
const tailN = tailArg ? Number(tailArg.slice("--tail=".length)) : 20;

async function supabaseGetAll(path) {
  const PAGE_SIZE = 1000;
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

async function main() {
  const [rows, oracleInfo, illegalRows] = await Promise.all([
    readOracleCardFile(oracleId),
    supabaseGetAll(`card_oracles?oracle_id=eq.${oracleId}&select=name`),
    supabaseGetAll("card_prints?select=scryfall_id&not_tournament_legal=eq.true"),
  ]);

  if (rows.length === 0) {
    console.log(`oracle-history/${oracleId}.ndjson.gz: データ無し`);
    return;
  }

  const name = oracleInfo[0]?.name ?? "(不明)";
  const illegal = new Set(illegalRows.map((r) => r.scryfall_id));
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  console.log(`${name} (${oracleId})`);
  console.log(`  総行数: ${sorted.length}件（${sorted[0].date} 〜 ${sorted[sorted.length - 1].date}）`);
  console.log(`\n直近${tailN}件:`);
  for (const r of sorted.slice(-tailN)) {
    const flag = r.scryfall_id && illegal.has(r.scryfall_id) ? " ⚠️使用不可版" : "";
    console.log(`  ${r.date}  ¥${r.jpy_est}  ${r.scryfall_id ?? "(scryfall_id無し)"}${flag}`);
  }

  const bad = sorted.filter((r) => r.scryfall_id && illegal.has(r.scryfall_id));
  const noId = sorted.filter((r) => !r.scryfall_id);
  console.log(`\n検査結果:`);
  console.log(`  使用不可版プリントの混入: ${bad.length}件${bad.length > 0 ? "  " + bad.map((r) => r.date).join(", ") : ""}`);
  console.log(`  scryfall_id無しの行: ${noId.length}件${noId.length > 0 ? "  " + noId.map((r) => r.date).join(", ") : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
