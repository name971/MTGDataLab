/**
 * 【一時利用・使い捨てスクリプト】price_history_archive（D1）のうち、scryfall_id列追加前に
 * 書き込まれた行（2026-07-25〜2026-08-06分、一括D1移行時にscryfall_idを持たせていなかった）
 * へ、print_price_history_archive（D1、プリント単位の同期間の価格履歴）とcard_prints
 * （Postgres、scryfall_id→oracle_id）から当時の「その日の最安プリント」を再計算して埋め直す。
 *
 * card_cheapest_price_snapshots（Postgres）は既に空でこの情報を持っていないため、
 * プリント単位のUSD価格から計算し直す以外に復元手段が無い。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/backfill-price-history-scryfall-ids.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定してください");
  process.exit(1);
}

// scryfall_id列を追加する前にD1へ書き込まれていた日付範囲（今日=D1_1にscryfall_idが既にある）
const START_DATE = "2026-07-25";
const END_DATE = "2026-08-06";

const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 150;
const STATEMENTS_PER_FILE = 50;

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

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-backfill-"));
  const filePath = join(dir, "batch.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execFileSync(
          "npx",
          ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`],
          { stdio: "inherit", shell: true },
        );
        return;
      } catch (err) {
        if (attempt === 3) throw err;
        console.error(`  ...D1書き込み失敗（試行${attempt}）、5秒後にリトライします`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function d1QueryViaCli(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--json", `--command="${sql}"`],
    { shell: true, encoding: "utf-8", maxBuffer: 1024 * 1024 * 200 },
  );
  const jsonStart = out.indexOf("[");
  const body = JSON.parse(out.slice(jsonStart));
  return body[0]?.results ?? [];
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log("card_prints（scryfall_id→oracle_id、使用不可フラグ）を取得中...");
  const printRows = await supabaseGet("card_prints?select=scryfall_id,oracle_id,not_tournament_legal");
  const oracleByScryfallId = new Map();
  for (const p of printRows) {
    if (p.not_tournament_legal) continue;
    oracleByScryfallId.set(p.scryfall_id, p.oracle_id);
  }
  console.log(`${oracleByScryfallId.size}件のプリント（使用可能分）を走査対象に`);

  const dates = [];
  for (let d = START_DATE; d <= END_DATE; d = addDays(d, 1)) dates.push(d);
  console.log(`対象日数: ${dates.length}日（${START_DATE}〜${END_DATE}）`);

  for (const date of dates) {
    console.log(`\n--- ${date} ---`);
    const priceRows = d1QueryViaCli(
      `SELECT scryfall_id, usd, usd_foil FROM print_price_history_archive WHERE date = '${date}'`,
    );
    console.log(`  プリント価格 ${priceRows.length}件取得`);

    const bestByOracle = new Map(); // oracle_id -> { normal: {usd, scryfallId}|null, foil: {...}|null }
    for (const row of priceRows) {
      const oracleId = oracleByScryfallId.get(row.scryfall_id);
      if (!oracleId) continue;
      const entry = bestByOracle.get(oracleId) ?? { normal: null, foil: null };
      if (row.usd != null && (!entry.normal || row.usd < entry.normal.usd)) {
        entry.normal = { usd: row.usd, scryfallId: row.scryfall_id };
      }
      if (row.usd_foil != null && (!entry.foil || row.usd_foil < entry.foil.usd)) {
        entry.foil = { usd: row.usd_foil, scryfallId: row.scryfall_id };
      }
      bestByOracle.set(oracleId, entry);
    }

    const updateRows = [...bestByOracle.entries()]
      .filter(([, e]) => e.normal || e.foil)
      .map(([oracleId, e]) => ({
        oracle_id: oracleId,
        date,
        scryfall_id: e.normal?.scryfallId ?? null,
        scryfall_id_foil: e.foil?.scryfallId ?? null,
      }));
    console.log(`  ${updateRows.length}件のオラクルに最安プリントを特定`);
    if (updateRows.length === 0) continue;

    const statements = [];
    for (let i = 0; i < updateRows.length; i += SQL_BATCH_SIZE) {
      const chunk = updateRows.slice(i, i + SQL_BATCH_SIZE);
      const values = chunk
        .map(
          (r) =>
            `(${sqlLiteral(r.oracle_id)}, ${sqlLiteral(r.date)}, ${sqlLiteral(r.scryfall_id)}, ${sqlLiteral(r.scryfall_id_foil)})`,
        )
        .join(",\n  ");
      // price_history_archiveの行は既に存在する前提（一括移行済み）なので、jpy_est/jpy_est_foilは
      // 触らずscryfall_id系だけ更新する（INSERT自体はON CONFLICTで既存行にフォールバックするため、
      // 万一行が無い場合だけ価格NULLのダミー行ができるが、date範囲・oracle_idは元々存在した対象のみ）
      statements.push(
        `INSERT INTO price_history_archive (oracle_id, date, scryfall_id, scryfall_id_foil) VALUES\n  ${values}\nON CONFLICT (oracle_id, date) DO UPDATE SET scryfall_id=excluded.scryfall_id, scryfall_id_foil=excluded.scryfall_id_foil;`,
      );
    }
    for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
      const fileStatements = statements.slice(i, i + STATEMENTS_PER_FILE);
      d1ExecuteFile(fileStatements.join("\n"));
      console.log(
        `  ...D1書き込み ${Math.min(i + STATEMENTS_PER_FILE, statements.length)}/${statements.length}バッチ`,
      );
    }
  }

  console.log("\n完了。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
