/**
 * 【一時利用・使い捨てスクリプト】MTGJSONのAllPrices.json（TCGplayerの過去90日分の日次価格、
 * https://mtgjson.com/downloads/all-files/）を使って、price_history_archive・
 * print_price_history_archive（D1）の実データが2026-07-25以前に無い問題を埋める。
 *
 * 2026-07-25以降は自前の日次スナップショット（実データ）が既にあるため上書きしない。
 * MTGJSONのuuidとうちのscryfall_idを対応付けるため、AllIdentifiers.jsonも使う
 * （identifiers.scryfallId）。
 *
 * オラクル単位の最安値計算はscripts/compute-cheapest-price-snapshots.mjsと同じロジック
 * （not_tournament_legalなプリントを除外し、TCGplayer normal/foilの最安値を取る）。
 *
 * 実行（メモリを多めに要求、圧縮ファイル2本で計約380MB・展開後は数GB規模になるため）:
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   node --max-old-space-size=8192 scripts/backfill-price-history-mtgjson.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pick } from "stream-json/filters/pick.js";
import { streamObject } from "stream-json/streamers/stream-object.js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME ?? "jp-mtgstocks-archive";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// 自前の日次アーカイブがこの日付以降は実データを持っているため、それより前だけ埋める
const REAL_ARCHIVE_START_DATE = "2026-07-25";

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
  const dir = mkdtempSync(join(tmpdir(), "d1-mtgjson-backfill-"));
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

// 既存行（2026-07-25以降の実データ）を絶対に上書きしないよう、常にINSERT OR IGNORE
function insertRowsIgnoreConflict(table, columns, rows) {
  const statements = [];
  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const chunk = rows.slice(i, i + SQL_BATCH_SIZE);
    const values = chunk.map((r) => `(${columns.map((c) => sqlLiteral(r[c])).join(", ")})`).join(",\n  ");
    statements.push(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES\n  ${values};`);
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
    const fileStatements = statements.slice(i, i + STATEMENTS_PER_FILE);
    d1ExecuteFile(fileStatements.join("\n"));
    console.log(`  ...${table} 書き込み ${Math.min(i + STATEMENTS_PER_FILE, statements.length)}/${statements.length}バッチ`);
  }
}

/**
 * AllIdentifiers.json / AllPrices.jsonは展開後1〜2GB超のJSONになり、丸ごと文字列化すると
 * V8の文字列長上限（約512MB）を超えてクラッシュする。そのため、gzipストリームを直接
 * stream-jsonへ流し込み、data.<uuid>のエントリ1件ずつをコールバックへ渡す（全体を
 * メモリ上に保持しない）。
 */
async function streamDataEntries(url, label, onEntry) {
  console.log(`${label}をダウンロード・パース中... (${url})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}のダウンロード失敗: ${res.status}`);

  let count = 0;
  await pipeline(
    Readable.fromWeb(res.body),
    createGunzip(),
    pick.withParserAsStream({ filter: "data" }),
    streamObject.asStream(),
    async function (source) {
      for await (const { key, value } of source) {
        onEntry(key, value);
        count++;
        if (count % 200000 === 0) console.log(`  ...${count}件処理`);
      }
    },
  );
  console.log(`  ${label} 完了（${count}件）`);
}

async function main() {
  // 1. uuid -> scryfallId マッピングを作る（必要な分だけ残してすぐ手放す）
  const scryfallIdByUuid = new Map();
  await streamDataEntries("https://mtgjson.com/api/v5/AllIdentifiers.json.gz", "AllIdentifiers.json", (uuid, card) => {
    const scryfallId = card.identifiers?.scryfallId;
    if (scryfallId) scryfallIdByUuid.set(uuid, scryfallId);
  });
  console.log(`uuid -> scryfallId マッピング: ${scryfallIdByUuid.size}件`);

  // 2. うちのDBが知っているプリントだけに絞るためのフィルタを用意
  console.log("card_prints（scryfall_id, oracle_id, not_tournament_legal）を取得中...");
  const printRows = await supabaseGet("card_prints?select=scryfall_id,oracle_id,not_tournament_legal");
  const oracleByScryfallId = new Map();
  const notTournamentLegalIds = new Set();
  for (const p of printRows) {
    oracleByScryfallId.set(p.scryfall_id, p.oracle_id);
    if (p.not_tournament_legal) notTournamentLegalIds.add(p.scryfall_id);
  }
  console.log(`${oracleByScryfallId.size}件のプリントを対象に`);

  // 3. AllPrices.jsonから、対象日付範囲・対象プリントのTCGplayer小売価格だけを抜き出す
  /** @type {Map<string, Map<string, { usd: number|null, usdFoil: number|null }>>} date -> scryfallId -> price */
  const byDate = new Map();
  let matchedPrints = 0;

  await streamDataEntries("https://mtgjson.com/api/v5/AllPrices.json.gz", "AllPrices.json", (uuid, priceData) => {
    const scryfallId = scryfallIdByUuid.get(uuid);
    if (!scryfallId || !oracleByScryfallId.has(scryfallId)) return;
    const retail = priceData?.paper?.tcgplayer?.retail;
    if (!retail) return;
    matchedPrints++;

    const normal = retail.normal ?? {};
    const foil = retail.foil ?? {};
    const dates = new Set([...Object.keys(normal), ...Object.keys(foil)]);
    for (const date of dates) {
      if (date >= REAL_ARCHIVE_START_DATE) continue; // 実データ期間は触らない
      let dateMap = byDate.get(date);
      if (!dateMap) byDate.set(date, (dateMap = new Map()));
      dateMap.set(scryfallId, {
        usd: typeof normal[date] === "number" ? normal[date] : null,
        usdFoil: typeof foil[date] === "number" ? foil[date] : null,
      });
    }
  });
  console.log(`TCGplayer価格がある対象プリント: ${matchedPrints}件、対象日付: ${byDate.size}日`);

  if (byDate.size === 0) {
    console.log("バックフィル対象の日付が無かったため終了します。");
    return;
  }

  // 4. 為替レートを対象日付分だけ確保する（無い日はFrankfurter APIの過去分から取得）
  console.log("既存の為替レートを確認中...");
  const existingRateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy,eur_to_jpy");
  const rateByDate = new Map(existingRateRows.map((r) => [r.date, r]));
  const missingDates = [...byDate.keys()].filter((d) => !rateByDate.has(d)).sort();

  if (missingDates.length > 0) {
    const start = missingDates[0];
    const end = missingDates[missingDates.length - 1];
    console.log(`為替レートが無い${missingDates.length}日分をFrankfurter APIから取得中 (${start}〜${end})...`);
    const [usdRes, eurRes] = await Promise.all([
      fetch(`https://api.frankfurter.dev/v1/${start}..${end}?base=USD&symbols=JPY`).then((r) => r.json()),
      fetch(`https://api.frankfurter.dev/v1/${start}..${end}?base=EUR&symbols=JPY`).then((r) => r.json()),
    ]);
    const newRateRows = [];
    for (const date of missingDates) {
      const usdToJpy = usdRes.rates?.[date]?.JPY;
      const eurToJpy = eurRes.rates?.[date]?.JPY;
      if (!usdToJpy) continue; // 為替市場の休日（土日等）はFrankfurter側にレートが無い
      const row = { date, usd_to_jpy: usdToJpy, eur_to_jpy: eurToJpy ?? null };
      newRateRows.push(row);
      rateByDate.set(date, row);
    }
    console.log(`  ${newRateRows.length}件の為替レートをexchange_ratesへ保存`);
    await supabaseUpsert("exchange_rates", newRateRows, "date");
  }

  // 土日祝等、為替レートが無い日は直近の平日レートで代用する（カード価格自体はMTGJSON側に
  // 存在するため、為替レートが無いという理由だけでその日を丸ごと捨てない）
  const knownRateDates = [...rateByDate.keys()].sort();
  function resolveRate(date) {
    let best = null;
    for (const d of knownRateDates) {
      if (d <= date) best = d;
      else break;
    }
    const fallback = best ?? knownRateDates.find((d) => d > date);
    return fallback ? Number(rateByDate.get(fallback).usd_to_jpy) : null;
  }

  // 5. 日付ごとに、プリント単位・オラクル単位（最安値）の行を組み立ててD1へ書き込む
  const sortedDates = [...byDate.keys()].sort();
  let totalPrintRows = 0;
  let totalOracleRows = 0;

  for (const date of sortedDates) {
    const rate = resolveRate(date);
    if (!rate) {
      console.log(`${date}: 為替レートが無いためスキップ`);
      continue;
    }
    const dateMap = byDate.get(date);

    const printRowsForDate = [];
    const bestByOracle = new Map(); // oracle_id -> { normal: {usd, scryfallId}|null, foil: {...}|null }

    for (const [scryfallId, price] of dateMap) {
      if (price.usd !== null || price.usdFoil !== null) {
        printRowsForDate.push({
          scryfall_id: scryfallId,
          date,
          usd: price.usd,
          usd_foil: price.usdFoil,
        });
      }
      if (notTournamentLegalIds.has(scryfallId)) continue;
      const oracleId = oracleByScryfallId.get(scryfallId);
      const entry = bestByOracle.get(oracleId) ?? { normal: null, foil: null };
      if (price.usd !== null && (!entry.normal || price.usd < entry.normal.usd)) {
        entry.normal = { usd: price.usd, scryfallId };
      }
      if (price.usdFoil !== null && (!entry.foil || price.usdFoil < entry.foil.usd)) {
        entry.foil = { usd: price.usdFoil, scryfallId };
      }
      bestByOracle.set(oracleId, entry);
    }

    const oracleRowsForDate = [];
    for (const [oracleId, entry] of bestByOracle) {
      if (!entry.normal && !entry.foil) continue;
      oracleRowsForDate.push({
        oracle_id: oracleId,
        date,
        jpy_est: entry.normal ? Math.round(entry.normal.usd * rate * 100) / 100 : null,
        jpy_est_foil: entry.foil ? Math.round(entry.foil.usd * rate * 100) / 100 : null,
        scryfall_id: entry.normal?.scryfallId ?? null,
        scryfall_id_foil: entry.foil?.scryfallId ?? null,
      });
    }

    console.log(`${date}: プリント${printRowsForDate.length}件・オラクル${oracleRowsForDate.length}件を書き込み中...`);
    insertRowsIgnoreConflict("print_price_history_archive", ["scryfall_id", "date", "usd", "usd_foil"], printRowsForDate);
    insertRowsIgnoreConflict(
      "price_history_archive",
      ["oracle_id", "date", "jpy_est", "jpy_est_foil", "scryfall_id", "scryfall_id_foil"],
      oracleRowsForDate,
    );
    totalPrintRows += printRowsForDate.length;
    totalOracleRows += oracleRowsForDate.length;
  }

  console.log(`\n完了。プリント単位${totalPrintRows}件・オラクル単位${totalOracleRows}件をバックフィルしました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
