/**
 * card_print_prices（Supabase、プリント単位・JSONB追記式）のうち、ARCHIVE_CUTOFF_DAYSより
 * 古い日付キーをCloudflare D1（jp-mtgstocks-archive、print_price_history_archiveテーブル）
 * へ移し、Supabase側のJSONBからは古いキーを取り除く。
 *
 * card_cheapest_price_snapshots（オラクル単位、scripts/archive-old-price-snapshots.mjs）
 * より対象件数が多く（プリント単位で約9.5万件）、同じ「毎日追記」設計のため約3倍のペースで
 * Supabase無料枠（500MB）を圧迫する。行ごと消せるcard_cheapest_price_snapshotsと違い、
 * こちらは1プリント1行のJSONBに日付キーが追記されていく構造なので、行削除ではなく
 * 「JSONBから古いキーだけ取り除いてPATCHし直す」方式になる。
 *
 * getLatestPricesForPrints（src/lib/dbCardPrintPrices.ts、「その他のプリント」欄の価格表示・
 * 代表画像選定）は各プリントの最新日の値しか見ないため、古い日付を取り除いても影響しない。
 * 個別プリントの価格推移グラフ（getPrintPriceHistory）だけが全履歴を必要とするため、
 * そちらはD1アーカイブと結合して表示する（同ファイル参照）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/archive-old-print-prices.mjs
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

// card_cheapest_price_snapshotsのアーカイブ閾値（scripts/archive-old-price-snapshots.mjs）と
// 揃える。compute-cheapest-price-snapshots.mjsはcard_print_pricesの現存する範囲だけを
// 見て毎回計算し直す設計なので、両方とも同じ60日（streak計算が必要とする範囲）に揃えて
// 間引いても計算の土台は壊れない（この2つのアーカイブは週次ワークフローで独立に動くため、
// 実行順序を気にする必要もない）。
const ARCHIVE_CUTOFF_DAYS = 60;
const PAGE_SIZE = 1000;
const SQL_BATCH_SIZE = 150; // 1行あたりusd/usd_foil2列×バインド変数、SQLite上限対策で保守的に

async function supabaseGetAll(path) {
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

async function supabasePatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function d1ExecuteFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), "d1-archive-"));
  const filePath = join(dir, "batch.sql");
  writeFileSync(filePath, sql, "utf-8");
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--file=${filePath}`],
      { stdio: "inherit", shell: true },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function d1QueryJson(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", `--command=${sql}`, "--json"],
    { encoding: "utf-8", shell: true },
  );
  return JSON.parse(out);
}

// wranglerのサブプロセス起動オーバーヘッドを抑えるため、複数のINSERT文を1ファイルにまとめて
// 実行回数を絞る（scripts/snapshot-print-prices.mjsと同じ理由）。
const STATEMENTS_PER_FILE = 50;

function insertArchiveRows(rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk
      .map((r) => `(${sqlLiteral(r.scryfall_id)}, ${sqlLiteral(r.date)}, ${sqlLiteral(r.usd)}, ${sqlLiteral(r.usd_foil)})`)
      .join(",\n  ");
    statements.push(
      `INSERT INTO print_price_history_archive (scryfall_id, date, usd, usd_foil) VALUES\n  ${values}\nON CONFLICT (scryfall_id, date) DO UPDATE SET usd=excluded.usd, usd_foil=excluded.usd_foil;`,
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

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_CUTOFF_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`card_print_pricesを取得中（${cutoffStr}より古い日付キーを対象）...`);
  const printRows = await supabaseGetAll("card_print_prices?select=scryfall_id,prices,prices_foil");
  console.log(`対象プリント: ${printRows.length}件`);

  const archiveRows = [];
  const trimmedRows = []; // { scryfall_id, prices, prices_foil } のうち実際にキーを削った行だけ

  for (const row of printRows) {
    const prices = row.prices ?? {};
    const pricesFoil = row.prices_foil ?? {};
    const allDates = new Set([...Object.keys(prices), ...Object.keys(pricesFoil)]);
    const oldDates = [...allDates].filter((d) => d < cutoffStr);
    if (oldDates.length === 0) continue;

    const newPrices = { ...prices };
    const newPricesFoil = { ...pricesFoil };
    for (const date of oldDates) {
      archiveRows.push({
        scryfall_id: row.scryfall_id,
        date,
        usd: prices[date] ?? null,
        usd_foil: pricesFoil[date] ?? null,
      });
      delete newPrices[date];
      delete newPricesFoil[date];
    }
    trimmedRows.push({ scryfall_id: row.scryfall_id, prices: newPrices, prices_foil: newPricesFoil });
  }

  console.log(`アーカイブ対象: ${archiveRows.length}件（日付キー単位）、${trimmedRows.length}プリント分`);
  if (archiveRows.length === 0) {
    console.log("アーカイブ対象がありません。終了します。");
    return;
  }

  console.log("D1へ書き込み中...");
  insertArchiveRows(archiveRows);

  // D1側に書き込めた件数を検証してからでないとSupabase側のJSONBは削らない
  const countJson = d1QueryJson(
    `SELECT COUNT(*) AS c FROM print_price_history_archive WHERE date < '${cutoffStr}'`,
  );
  const archivedCount = countJson[0]?.results?.[0]?.c ?? 0;
  console.log(`D1側の確認: date < ${cutoffStr} の行数 = ${archivedCount}`);
  if (archivedCount < archiveRows.length) {
    throw new Error(
      `D1への書き込み件数(${archivedCount})が想定件数(${archiveRows.length})を下回っています。` +
        "Supabase側のJSONB更新は行わず中断します。",
    );
  }

  console.log("Supabase側のJSONBから古い日付キーを削除中...");
  for (let i = 0; i < trimmedRows.length; i++) {
    const r = trimmedRows[i];
    await supabasePatch(`card_print_prices?scryfall_id=eq.${r.scryfall_id}`, {
      prices: r.prices,
      prices_foil: r.prices_foil,
    });
    if ((i + 1) % 200 === 0) console.log(`  ...${i + 1}/${trimmedRows.length}プリント`);
  }

  console.log(
    `\n完了: ${archiveRows.length}件（${trimmedRows.length}プリント分）をD1へアーカイブし、Supabase側のJSONBを間引きました。`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
