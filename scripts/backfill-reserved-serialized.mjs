/**
 * 【一時利用・使い捨てスクリプト】card_oracles（Postgres）・catalog_oracles（D1、デッキ未使用の
 * カタログのみカード）に is_reserved / is_serialized を後付けで埋める。価格予測機能の候補カード
 * フィルタ（再録禁止リスト該当 or シリアル番号入り or 価格一定額以上）に必要。
 *
 * 再録禁止リストは1999年以前の古いカードが中心でデッキではほぼ使われないため、対象の大半は
 * Postgresではなくデッキ未使用カード用のD1 catalog_oracles側にいる。
 *
 * どちらもオラクル単位の1カラムにする（Scryfallのreservedは同一オラクルの全プリントで
 * 一律trueのため、is_reservedはどの版を見ても同じ。is_serializedは特定の版だけの属性だが、
 * 「いずれかの版がシリアル入りか」を1回のバルクデータ走査でオラクル単位に集約して持つ）。
 *
 * 実行前提: ALTER TABLE card_oracles ADD COLUMN is_reserved/is_serialized（実行済み）、
 * D1 catalog_oraclesも同様に実行済み。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *       CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *       node scripts/backfill-reserved-serialized.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBulkData, forEachJsonArrayObject, DATA_FILE } from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

async function supabaseGet(path) {
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

async function supabaseUpsert(table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-reserved-"));
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

function updateD1Rows(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk
      .map((r) => `('${r.oracle_id}', ${r.is_reserved ? 1 : 0}, ${r.is_serialized ? 1 : 0})`)
      .join(",\n  ");
    statements.push(
      `WITH v(oracle_id, is_reserved, is_serialized) AS (VALUES\n  ${values}\n)\nUPDATE catalog_oracles SET is_reserved = v.is_reserved, is_serialized = v.is_serialized FROM v WHERE catalog_oracles.oracle_id = v.oracle_id;`,
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
    const fileStatements = statements.slice(i, i + STATEMENTS_PER_FILE);
    d1ExecuteFile(fileStatements.join("\n"));
    console.log(`  ...D1書き込み ${Math.min(i + STATEMENTS_PER_FILE, statements.length)}/${statements.length}バッチ`);
  }
}

async function main() {
  await ensureBulkData();

  // oracle_id -> { reserved, serialized }（全プリントを見てOR集約する）
  const flagsByOracle = new Map();
  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (!raw.oracle_id) return;
    const current = flagsByOracle.get(raw.oracle_id) ?? { reserved: false, serialized: false };
    if (raw.reserved) current.reserved = true;
    if (raw.promo_types?.includes("serialized")) current.serialized = true;
    flagsByOracle.set(raw.oracle_id, current);
  });
  console.log(`バルクデータ走査: ${scanned}件、対象oracle_id ${flagsByOracle.size}件`);
  const reservedCount = [...flagsByOracle.values()].filter((f) => f.reserved).length;
  const serializedCount = [...flagsByOracle.values()].filter((f) => f.serialized).length;
  console.log(`  再録禁止: ${reservedCount}件、シリアル番号入り: ${serializedCount}件`);

  console.log("既存のcard_oracles（Postgres）を確認中...");
  // PostgRESTのupsert(on_conflict)はINSERT ON CONFLICT DO UPDATEとして実行されるため、
  // NOT NULL制約のあるname等を含めずis_reserved/is_serializedだけ送るとINSERT側の検証で
  // 落ちる（実際に発生した）。既存値をそのまま乗せて送り返す。
  const pgOracles = await supabaseGet("card_oracles?select=oracle_id,name,printed_name_ja,oracle_text");
  const pgOracleByid = new Map(pgOracles.map((r) => [r.oracle_id, r]));
  console.log(`  ${pgOracleByid.size}件`);

  const pgUpdateRows = [];
  const d1UpdateRows = [];
  for (const [oracleId, flags] of flagsByOracle) {
    if (!flags.reserved && !flags.serialized) continue; // デフォルトfalseのままで良い分は書き込み省略
    const existing = pgOracleByid.get(oracleId);
    if (existing) {
      pgUpdateRows.push({ ...existing, is_reserved: flags.reserved, is_serialized: flags.serialized });
    } else {
      d1UpdateRows.push({ oracle_id: oracleId, is_reserved: flags.reserved, is_serialized: flags.serialized }); // Postgresに無ければD1のcatalog_oracles側にいるはず（無ければ単に対象外）
    }
  }
  console.log(`Postgres更新対象: ${pgUpdateRows.length}件、D1更新対象: ${d1UpdateRows.length}件`);

  console.log("Postgres（card_oracles）を更新中...");
  await supabaseUpsert("card_oracles", pgUpdateRows, "oracle_id");

  console.log("D1（catalog_oracles）を更新中...");
  updateD1Rows(d1UpdateRows);

  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
