/**
 * catalog_prints（D1、デッキ未使用カードの全プリント一覧、rebuild-card-prints.mjsのD1版）を
 * Scryfallバルクデータから作り直す。
 *
 * これまで一度も投入されておらず0件のままだった（過去の一回限りの移行スクリプトが
 * catalog_oraclesだけ作ってcatalog_printsを埋め忘れていた）ため、デッキ未使用カードの
 * カード詳細ページで「その他のプリント」欄が常に0件になっていた。
 *
 * 実行: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/rebuild-catalog-prints.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  NON_TOURNAMENT_SET_TYPES,
  resolveOracleId,
} from "./lib/scryfallBulk.mjs";

const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

function isNotTournamentLegal(raw) {
  if (raw.set_type === "funny") return raw.security_stamp === "acorn";
  return raw.border_color === "gold" || raw.border_color === "silver" || NON_TOURNAMENT_SET_TYPES.has(raw.set_type);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-catalog-prints-"));
  const filePath = join(dir, "batch.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`], {
      stdio: "inherit",
      shell: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SQL_BATCH_SIZE = 150;
const STATEMENTS_PER_FILE = 50;
const COLUMNS = [
  "scryfall_id",
  "oracle_id",
  "set_code",
  "set_name",
  "collector_number",
  "released_at",
  "image_uri_normal",
  "image_uri_normal_ja",
  "rarity",
  "not_tournament_legal",
];

function insertPrintRows(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk.map((r) => `(${COLUMNS.map((c) => sqlLiteral(r[c])).join(", ")})`).join(",\n  ");
    statements.push(
      `INSERT OR REPLACE INTO catalog_prints (${COLUMNS.join(", ")}) VALUES\n  ${values};`,
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
    const fileStatements = statements.slice(i, i + STATEMENTS_PER_FILE);
    d1ExecuteFile(fileStatements.join("\n"));
    console.log(`  ...D1書き込み ${Math.min(i + STATEMENTS_PER_FILE, statements.length)}/${statements.length}バッチ`);
  }
}

function d1Query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--json", `--command="${sql}"`],
    { shell: true, encoding: "utf-8", maxBuffer: 1024 * 1024 * 200 },
  );
  const jsonStart = out.indexOf("[");
  const body = JSON.parse(out.slice(jsonStart));
  return body[0]?.results ?? [];
}

async function main() {
  await ensureBulkData();

  console.log("D1: catalog_oracles（対象oracle_id）を取得中...");
  const oracleRows = d1Query("SELECT oracle_id FROM catalog_oracles");
  const knownOracleIds = new Set(oracleRows.map((r) => r.oracle_id));
  console.log(`  ${knownOracleIds.size}件`);

  const byPrintKey = new Map();
  const jaImageByPrintKey = new Map();
  const LANG_PRIORITY = { en: 2, ja: 1 };
  const langScore = (lang) => LANG_PRIORITY[lang] ?? 0;

  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (raw.digital) return;
    const oracleId = resolveOracleId(raw);
    if (!oracleId || !knownOracleIds.has(oracleId)) return;

    const key = `${oracleId}|${raw.set}|${raw.collector_number}`;

    if (raw.lang === "ja") {
      const face = raw.card_faces?.[0];
      const imageUris = raw.image_uris ?? face?.image_uris ?? null;
      if (imageUris?.normal) jaImageByPrintKey.set(key, imageUris.normal);
    }

    const current = byPrintKey.get(key);
    if (current && langScore(current.lang) >= langScore(raw.lang)) return;
    byPrintKey.set(key, { raw, oracleId });
  });
  console.log(`バルクデータ走査: ${scanned}件中 ${byPrintKey.size}件が対象`);

  const prints = [...byPrintKey.values()].map(({ raw, oracleId }) => {
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    const key = `${oracleId}|${raw.set}|${raw.collector_number}`;
    return {
      scryfall_id: raw.id,
      oracle_id: oracleId,
      set_code: raw.set,
      set_name: raw.set_name,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
      image_uri_normal_ja: jaImageByPrintKey.get(key) ?? null,
      rarity: raw.rarity ?? null,
      not_tournament_legal: isNotTournamentLegal(raw) ? 1 : 0,
    };
  });

  console.log(`D1（catalog_prints）へ${prints.length}件書き込み中...`);
  insertPrintRows(prints);
  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
