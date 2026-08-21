/**
 * src/lib/bannedCards.ts（/banned-cardsページ用の手動キュレーションリスト）から、
 * 「禁止」（status: "restricted"以外。制限は対象外 — 制限は1枚まで使えるので採用率が
 * 0にはならない）のみを抽出し、カード名をoracle_idに解決してローカルに書き出す。
 * 学習用の"今後採用率が0になる"シグナルとして使う。
 *
 * どこにも書き込みは行わない（完全ローカル）。
 *
 * 実行: node ml/build_banned_history.mjs
 * 出力: ml/data/banned_history.ndjson （1行 = 1オラクルの1フォーマットでの禁止開始日）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureBulkData, loadIndex, findEnglishCard } from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadBannedCardEntries() {
  const source = readFileSync(join(__dirname, "..", "src", "lib", "bannedCards.ts"), "utf-8");
  const match = source.match(/export const BANNED_CARDS: BannedCardEntry\[\] = (\[[\s\S]*?\n\]);/);
  if (!match) throw new Error("BANNED_CARDS配列が見つかりませんでした（bannedCards.tsの形式が変わった？）");
  // 中身はTS型注釈を含まないプレーンなオブジェクトリテラルの配列なので、そのままJSとして評価できる
  // eslint-disable-next-line no-eval
  return (0, eval)(match[1]);
}

async function main() {
  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();
  const index = await loadIndex();

  const entries = loadBannedCardEntries();
  const bannedOnly = entries.filter((e) => e.status !== "restricted");
  console.log(`${entries.length}件中、禁止（制限以外）: ${bannedOnly.length}件`);

  const rows = [];
  let unresolved = 0;
  for (const entry of bannedOnly) {
    const card = findEnglishCard(index, entry.name);
    if (!card) {
      unresolved++;
      continue;
    }
    const banDate = `${entry.year}-${String(entry.month ?? 1).padStart(2, "0")}-01`;
    rows.push({ oracle_id: card.oracle_id, format: entry.format, ban_date: banDate });
  }
  console.log(`解決: ${rows.length}件（未解決: ${unresolved}件）`);

  const outPath = join(__dirname, "data", "banned_history.ndjson");
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`書き出し完了: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
