/**
 * 指定オラクルのカード単位ファイル（oracle-history/{oracleId}.ndjson.gz）を、
 * 既にクリーンな月次バルクファイル（price-history/YYYY-MM.ndjson.gz）の内容で
 * 同期し直す。2026-08-24、月次ファイルの汚染除去は行ったのにカード単位ファイルへの
 * 反映が一部漏れていた事故（Time Walk等135件）を受けて、汎用ツールとして切り出した。
 * 月次ファイル側の該当月のデータで、指定オラクルの該当日付を上書きする（他の日付は
 * 保持する差分マージ）。
 *
 * 実行: node scripts/resync-oracle-history.mjs --oracles=path/to/ids.csv --months=2026-08,2026-07
 *   --oracles=: 1行1 oracle_id のCSV（ヘッダー行"oracle_id"を含めても可）
 *   --months=: カンマ区切りで対象月（YYYY-MM）を複数指定可
 */

import { readFileSync } from "node:fs";
import { readOraclePriceMonth, mergeOracleCardFile, runWithConcurrency } from "./lib/r2PriceArchive.mjs";

const oraclesArg = process.argv.find((a) => a.startsWith("--oracles="));
const monthsArg = process.argv.find((a) => a.startsWith("--months="));
if (!oraclesArg || !monthsArg) {
  console.error("使い方: node scripts/resync-oracle-history.mjs --oracles=ids.csv --months=2026-08,2026-07");
  process.exit(1);
}

const oracleIds = readFileSync(oraclesArg.slice("--oracles=".length), "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && l !== "oracle_id");
const months = monthsArg.slice("--months=".length).split(",").filter(Boolean);

async function main() {
  console.log(`対象: ${oracleIds.length}オラクル × ${months.length}ヶ月分`);

  const byOracle = new Map();
  for (const month of months) {
    const rows = await readOraclePriceMonth(month);
    for (const r of rows) {
      if (!byOracle.has(r.oracle_id)) byOracle.set(r.oracle_id, []);
      byOracle.get(r.oracle_id).push(r);
    }
    console.log(`  ${month}: ${rows.length}行読み込み`);
  }

  let synced = 0;
  const failed = await runWithConcurrency(oracleIds, 16, async (oracleId) => {
    const rows = byOracle.get(oracleId);
    if (!rows || rows.length === 0) return;
    await mergeOracleCardFile(oracleId, rows);
    synced++;
  });

  console.log(`完了: ${synced}件同期（対象月データ無しでスキップ: ${oracleIds.length - synced - failed}件、失敗: ${failed}件）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
