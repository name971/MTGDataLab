/**
 * Scryfallバルクデータ（scripts/lib/scryfallBulk.mjs）から、オラクルごとの再録日
 * （通常プリントのリリース日、重複除去済み）をローカルに書き出す。
 *
 * 同じセット・同じ発売日に複数バリエーション（通常/ショーケース/ボーダーレス等）が
 * 出ることが多いが、それらは1回の「再録イベント」として扱うため発売日で重複除去する。
 * 使用不可プリント（docs/spec.md参照、rebuild-catalog-prints.mjsと同じ判定）は
 * 再録カウントに含めない（ジョーク/メモラビリア商品は実勢価格への影響が薄いため）。
 *
 * どこにも書き込みは行わない（完全ローカル）。
 *
 * 実行: node ml/build_reprint_history.mjs
 * 出力: ml/data/reprint_history.ndjson （1行 = 1オラクルの1発売日）
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  NON_TOURNAMENT_SET_TYPES,
} from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isNotTournamentLegal(raw) {
  if (raw.set_type === "funny") return raw.security_stamp === "acorn";
  return raw.border_color === "gold" || raw.border_color === "silver" || NON_TOURNAMENT_SET_TYPES.has(raw.set_type);
}

async function main() {
  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();

  // oracle_id -> Set<release_date>
  const releaseDatesByOracle = new Map();

  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || !raw.oracle_id || !raw.released_at) return;
    if (isNotTournamentLegal(raw)) return;
    if (!releaseDatesByOracle.has(raw.oracle_id)) releaseDatesByOracle.set(raw.oracle_id, new Set());
    releaseDatesByOracle.get(raw.oracle_id).add(raw.released_at);
  });

  const rows = [];
  for (const [oracleId, dates] of releaseDatesByOracle) {
    for (const releaseDate of dates) {
      rows.push({ oracle_id: oracleId, release_date: releaseDate });
    }
  }

  console.log(`${releaseDatesByOracle.size}オラクル、${rows.length}件の発売日（重複除去済み）`);

  const outPath = join(__dirname, "data", "reprint_history.ndjson");
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`書き出し完了: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
