/**
 * price-history/YYYY-MM.ndjson.gz（月次、全オラクル横断）から
 * oracle-history/{oracleId}.ndjson.gz（オラクル単位、カードデータページ表示用）へ
 * 差分反映する。scripts/rebuild-print-history-cards.mjsのオラクル版（対称性のため
 * 同じ--months=差分更新モードのみを持つ、全期間再構築は今のところ不要）。
 *
 * 実行: node scripts/rebuild-oracle-history-cards.mjs --months=2026-08
 * 環境変数: R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=...
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readOraclePriceMonth, mergeOracleCardFile, runWithConcurrency } from "./lib/r2PriceArchive.mjs";

const STAGING_DIR = path.join(process.cwd(), ".rebuild-oracle-history-staging");

function parseMonthsArg() {
  const arg = process.argv.find((a) => a.startsWith("--months="));
  if (!arg) throw new Error("--months=YYYY-MM,YYYY-MM を指定してください");
  return arg.slice("--months=".length).split(",").filter(Boolean);
}

async function main() {
  const months = parseMonthsArg();
  console.log(`差分更新モード: 対象月 ${months.join(", ")}`);

  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  for (const month of months) {
    const rows = await readOraclePriceMonth(month);
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.oracle_id)) byId.set(r.oracle_id, []);
      byId.get(r.oracle_id).push(r);
    }
    for (const [oracleId, cardRows] of byId) {
      const body = cardRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      appendFileSync(path.join(STAGING_DIR, `${oracleId}.ndjson`), body);
    }
    console.log(`  ${month}: ${rows.length}行 → ${byId.size}オラクル分をローカルへ追記`);
  }

  const files = readdirSync(STAGING_DIR);
  console.log(`ローカル集約完了: ${files.length}オラクル分。R2へマージアップロード中...`);

  let done = 0;
  const failed = await runWithConcurrency(files, 16, async (file) => {
    const oracleId = file.replace(/\.ndjson$/, "");
    const text = readFileSync(path.join(STAGING_DIR, file), "utf-8");
    const byDate = new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      byDate.set(row.date, row);
    }
    await mergeOracleCardFile(oracleId, [...byDate.values()]);
    done++;
    if (done % 5000 === 0) console.log(`  ...${done}/${files.length}件アップロード済み`);
  });

  rmSync(STAGING_DIR, { recursive: true, force: true });
  console.log(`完了。${files.length}オラクル分のカード単位ファイルを更新しました（失敗: ${failed}件）。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
