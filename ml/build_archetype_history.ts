/**
 * ml/data/topdeck_raw_cache/にキャッシュ済みのTopDeck.gg生レスポンスを、サイトで
 * 実際に使っているアーキタイプ判定エンジン（src/lib/archetypeEngine.ts、
 * scripts/classify-decks.tsと同じロジック）で再分類し、
 * (oracle_id, event_date, archetype, format)のNDJSONを書き出す。
 *
 * ユーザー指摘（2026-08-16）: 「サイトで使っている分類器を使ってほしい」に対応。
 * 独自の分類器は作らず、既存のBadaro/MTGOFormatDataルール+archetypeEngine.tsを
 * そのまま流用する。
 *
 * どこにも書き込みは行わない（完全ローカル。TopDeck APIへの再アクセスも無い、
 * 既にキャッシュ済みの生データを再利用するだけ）。
 *
 * 実行: npx tsx ml/build_archetype_history.ts
 * 出力: ml/data/archetype_history.ndjson
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyDeck } from "../src/lib/archetypeEngine.ts";
import { ensureBulkData, loadIndex, findEnglishCard } from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_CACHE_DIR = join(__dirname, "data", "topdeck_raw_cache");

const FORMATS = ["Standard", "Pioneer", "Modern", "Legacy", "Vintage"]; // Commanderはアーキタイプ概念が薄いため対象外
const FORMAT_ALIASES = { Commander: "EDH" };
const REPO_RAW = "https://raw.githubusercontent.com/Badaro/MTGOFormatData/master";

async function listDir(path) {
  const res = await fetch(`https://api.github.com/repos/Badaro/MTGOFormatData/contents/${path}`);
  if (!res.ok) return [];
  const entries = await res.json();
  return entries.filter((e) => e.name.endsWith(".json")).map((e) => e.name);
}

async function fetchJson(path) {
  const res = await fetch(`${REPO_RAW}/${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadFormatData(format) {
  const archetypeFiles = await listDir(`Formats/${format}/Archetypes`);
  const fallbackFiles = await listDir(`Formats/${format}/Fallbacks`);
  const archetypes = (
    await Promise.all(archetypeFiles.map((f) => fetchJson(`Formats/${format}/Archetypes/${f}`)))
  ).filter(Boolean);
  const fallbacks = (
    await Promise.all(fallbackFiles.map((f) => fetchJson(`Formats/${format}/Fallbacks/${f}`)))
  ).filter(Boolean);
  console.log(`  ${format}: アーキタイプ${archetypes.length}件、フォールバック${fallbacks.length}件`);
  return { format, archetypes, fallbacks, fallbackMinOverlap: 3 };
}

function readCachedChunks(format) {
  const topdeckFormat = FORMAT_ALIASES[format] ?? format;
  const prefix = `${format}_`;
  const files = readdirSync(RAW_CACHE_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  const tournaments = [];
  for (const file of files) {
    const body = JSON.parse(readFileSync(join(RAW_CACHE_DIR, file), "utf-8"));
    tournaments.push(...body);
  }
  return tournaments;
}

function resolveOracleId(index, cardName, unresolvedCounter) {
  const card = findEnglishCard(index, cardName);
  if (!card) {
    unresolvedCounter.count++;
    return null;
  }
  return card.oracle_id;
}

async function main() {
  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();
  const index = await loadIndex();

  const outPath = join(__dirname, "data", "archetype_history.ndjson");
  writeFileSync(outPath, "");

  const unresolvedCounter = { count: 0 };
  let totalRowCount = 0;

  console.log("MTGOFormatDataのルールを取得中...");
  for (const format of FORMATS) {
    const formatData = await loadFormatData(format);
    const tournaments = readCachedChunks(format);
    console.log(`  ${format}: キャッシュから${tournaments.length}件のトーナメントを読み込み`);

    let chunkLines = "";
    let rowCount = 0;
    for (const t of tournaments) {
      const eventDate = new Date(t.startDate * 1000).toISOString().slice(0, 10);
      for (const standing of t.standings ?? []) {
        if (!standing.deckObj) continue;

        const mainboard = [];
        const sideboard = [];
        for (const [boardName, cards] of Object.entries(standing.deckObj)) {
          if (boardName === "metadata") continue;
          const boardLower = boardName.toLowerCase();
          if (boardLower.startsWith("commander")) continue;
          const target = boardLower.startsWith("side") ? sideboard : mainboard;
          for (const [cardName, info] of Object.entries(cards)) {
            target.push({ name: cardName, count: Number(info?.count) || 1 });
          }
        }
        if (mainboard.length === 0) continue;

        const result = classifyDeck({ mainboard, sideboard }, formatData);
        if (result.matchedBy === "unclassified") continue; // 未分類デッキは特徴量として使えないため捨てる

        // メインボードのカードだけをオラクル解決してarchetypeと紐付ける
        const mainOracleIds = new Set();
        for (const card of mainboard) {
          const oracleId = resolveOracleId(index, card.name, unresolvedCounter);
          if (oracleId) mainOracleIds.add(oracleId);
        }
        for (const oracleId of mainOracleIds) {
          chunkLines += JSON.stringify({ oracle_id: oracleId, event_date: eventDate, archetype: result.archetype, format }) + "\n";
          rowCount++;
        }
      }
    }
    if (chunkLines) writeFileSync(outPath, chunkLines, { flag: "a" });
    totalRowCount += rowCount;
    console.log(`  ${format}: ${rowCount}行を書き出し済み`);
  }

  console.log(`\n完了: ${totalRowCount}行（未解決カード名 ${unresolvedCounter.count}件、無視）`);
  console.log(`書き出し先: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
