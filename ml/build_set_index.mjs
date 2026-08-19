/**
 * Scryfallバルクデータから scryfall_id -> set_code のマッピングをローカルに書き出す。
 * ml/features.pyがセット単位の相対値動き特徴量（set_avg_return_7d等）を計算する際に使う。
 * どこにも書き込みは行わない（完全ローカル）。
 *
 * 実行: node ml/build_set_index.mjs
 * 出力: ml/data/scryfall_set_index.ndjson （1行 = 1プリント）
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureBulkData, forEachJsonArrayObject, DATA_FILE } from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();

  const rows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || !raw.id || !raw.set) return;
    rows.push({ scryfall_id: raw.id, set_code: raw.set });
  });

  console.log(`${rows.length}件のプリント`);
  const outPath = join(__dirname, "data", "scryfall_set_index.ndjson");
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`書き出し完了: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
