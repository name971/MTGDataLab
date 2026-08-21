/**
 * Standardローテーションまでの残り日数（Pawlicki et al. 2014の特徴量27番
 * 「Days until card loses tournament legality」着想、2026-08-16）を計算する。
 *
 * 正確なローテーション規則（告知ベースの複雑な変遷）を再現するのは困難なため、
 * 「そのオラクルが現在Standard合法な最も古いプリントの発売日 + 3年」を
 * ローテーション予定日の近似値として使う（現行ルールはおおむね直近3年分の
 * セットがStandardに残る設計）。近似だが、古いセットほどローテーションが近い、
 * という順序関係は正しく捉えられる。
 *
 * どこにも書き込みは行わない（完全ローカル）。
 *
 * 実行: node ml/build_standard_rotation.mjs
 * 出力: ml/data/standard_rotation.ndjson （1行 = 1オラクル）
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureBulkData, forEachJsonArrayObject, DATA_FILE } from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROTATION_YEARS = 3;

async function main() {
  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();

  // oracle_id -> 現在Standard合法な最も古いプリントの発売日
  const earliestStandardRelease = new Map();

  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || !raw.oracle_id || !raw.released_at) return;
    if (raw.legalities?.standard !== "legal") return;
    const current = earliestStandardRelease.get(raw.oracle_id);
    if (!current || raw.released_at < current) {
      earliestStandardRelease.set(raw.oracle_id, raw.released_at);
    }
  });

  const rows = [];
  for (const [oracleId, releaseDate] of earliestStandardRelease) {
    const rotationDate = new Date(releaseDate);
    rotationDate.setFullYear(rotationDate.getFullYear() + ROTATION_YEARS);
    rows.push({ oracle_id: oracleId, rotation_date: rotationDate.toISOString().slice(0, 10) });
  }

  console.log(`${rows.length}件のStandard合法オラクル`);
  const outPath = join(__dirname, "data", "standard_rotation.ndjson");
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`書き出し完了: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
