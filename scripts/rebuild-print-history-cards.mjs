/**
 * print-price-history/YYYY-MM.ndjson.gz（月次、全プリント横断）から
 * print-history/{scryfallId}.ndjson.gz（プリント単位、サイト表示用）を作り直す。
 *
 * 元々はml/fetch_tcgcsv_history.pyが月次ファイルにしか書いておらずプリント詳細ページが読む
 * カード単位ファイルが空のままだった問題の復旧用スクリプトだった（docs/incident-log.md参照）。
 * 過去数日分だけ月次ファイルへ後から追記した場合（TCGCSVの遅延取得等）に、その分だけ
 * カード単位ファイルへ反映したいだけなのに毎回全期間（30ヶ月超・97,589プリント）を
 * 再構築する必要があり、R2書き込み無料枠を無駄に消費していた（2026-08-21、1回で
 * 97,589件のPutObjectを消費し、無料枠100万件/月の1割近くを1回の実行で使い切った）。
 * --months=YYYY-MM,YYYY-MM で対象月を絞れる差分更新モードを追加した。
 *
 * 実行:
 *   全期間再構築: node scripts/rebuild-print-history-cards.mjs
 *   差分更新:     node scripts/rebuild-print-history-cards.mjs --months=2026-08
 * 環境変数: R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=...
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  monthsUpToToday,
  readPrintPriceMonth,
  writePrintCardFileDirect,
  mergePrintCardFile,
  runWithConcurrency,
} from "./lib/r2PriceArchive.mjs";

const STAGING_DIR = path.join(process.cwd(), ".rebuild-print-history-staging");

function parseMonthsArg() {
  const arg = process.argv.find((a) => a.startsWith("--months="));
  return arg ? arg.slice("--months=".length).split(",").filter(Boolean) : null;
}

async function main() {
  const targetMonths = parseMonthsArg();
  const isDiff = targetMonths !== null;
  const months = targetMonths ?? monthsUpToToday();
  console.log(
    isDiff
      ? `差分更新モード: 対象月 ${months.join(", ")}`
      : `全期間再構築モード: ${months.length}ヶ月分（${months[0]}〜${months[months.length - 1]}）`,
  );

  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  for (const month of months) {
    const rows = await readPrintPriceMonth(month);
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.scryfall_id)) byId.set(r.scryfall_id, []);
      byId.get(r.scryfall_id).push(r);
    }
    for (const [scryfallId, cardRows] of byId) {
      const body = cardRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      appendFileSync(path.join(STAGING_DIR, `${scryfallId}.ndjson`), body);
    }
    console.log(`  ${month}: ${rows.length}行 → ${byId.size}プリント分をローカルへ追記`);
  }

  const files = readdirSync(STAGING_DIR);
  console.log(
    `ローカル集約完了: ${files.length}プリント分。R2へ${isDiff ? "マージ" : "上書き"}アップロード中...`,
  );

  let done = 0;
  const failed = await runWithConcurrency(files, 16, async (file) => {
    const scryfallId = file.replace(/\.ndjson$/, "");
    const text = readFileSync(path.join(STAGING_DIR, file), "utf-8");
    const byDate = new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      byDate.set(row.date, row); // 同日重複は最後（=一番新しく読んだ月）の値で上書き
    }
    const rows = [...byDate.values()];
    // 全期間再構築時は既存ファイルの内容を全部作り直す想定なのでGET不要（直接上書き、
    // R2読み取りリクエスト分を節約できる）。差分更新時は対象月以外の履歴を消さないよう
    // 既存ファイルとマージする。
    await (isDiff ? mergePrintCardFile(scryfallId, rows) : writePrintCardFileDirect(scryfallId, rows));
    done++;
    if (done % 5000 === 0) console.log(`  ...${done}/${files.length}件アップロード済み`);
  });

  rmSync(STAGING_DIR, { recursive: true, force: true });
  console.log(`完了。${files.length}プリント分のカード単位ファイルを更新しました（失敗: ${failed}件）。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
