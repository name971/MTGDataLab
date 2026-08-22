/**
 * scripts/snapshot-print-prices.mjs + scripts/compute-cheapest-price-snapshots.mjs の
 * ローカルPostgres版（Postgres部分のみ、R2履歴書き込みは省略）。
 * Scryfallバルクデータの現在価格から、card_print_current_prices（プリント単位）と
 * card_current_prices（オラクル単位、全プリント中の最安値）を構築する
 * （Supabase復旧待ちの間、サイト復旧に必要な現在価格キャッシュをこのPC上で先に作るため）。
 *
 * 実行: LOCAL_POSTGRES_URL=... node scripts/snapshot-current-prices-local.mjs
 */
import pg from "pg";
import { ensureBulkData, buildPriceIndex, findPriceById } from "./lib/scryfallBulk.mjs";

const LOCAL_POSTGRES_URL = process.env.LOCAL_POSTGRES_URL;
if (!LOCAL_POSTGRES_URL) {
  console.error("LOCAL_POSTGRES_URL を設定してください");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: LOCAL_POSTGRES_URL, max: 4 });
const BATCH_SIZE = 1000;

async function bulkUpsert(table, rows, columns, conflictColumn) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = chunk
      .map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(",")})`)
      .join(",");
    const params = chunk.flatMap((row) => columns.map((col) => row[col] ?? null));
    const updateSet = columns.filter((c) => c !== conflictColumn).map((c) => `${c} = EXCLUDED.${c}`).join(",");
    await pool.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}
       ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateSet}`,
      params,
    );
    console.log(`  ${table}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}件...`);
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: rateRows } = await pool.query(
    "SELECT usd_to_jpy FROM exchange_rates ORDER BY date DESC LIMIT 1",
  );
  const rate = rateRows[0] ? Number(rateRows[0].usd_to_jpy) : null;
  if (!rate) {
    console.error("為替レートが1件も無いため中断します。先にexchange_ratesを埋めてください。");
    process.exit(1);
  }
  console.log(`使用するレート: ${rate}円/$`);

  console.log("Scryfallバルクデータを準備中...");
  await ensureBulkData();
  const index = await buildPriceIndex();

  const { rows: prints } = await pool.query("SELECT scryfall_id, oracle_id FROM card_prints");
  console.log(`対象プリント: ${prints.length}件`);

  const printCacheRows = [];
  for (const p of prints) {
    const price = findPriceById(index, p.scryfall_id);
    const usd = price?.usd != null ? parseFloat(price.usd) : null;
    const usdFoil = price?.usd_foil != null ? parseFloat(price.usd_foil) : null;
    if (usd === null && usdFoil === null) continue;
    printCacheRows.push({ scryfall_id: p.scryfall_id, oracle_id: p.oracle_id, date: today, usd, usd_foil: usdFoil });
  }
  console.log(`価格あり: ${printCacheRows.length}件（プリント単位）`);

  console.log("card_print_current_pricesを更新中...");
  await bulkUpsert(
    "card_print_current_prices",
    printCacheRows,
    ["scryfall_id", "oracle_id", "date", "usd", "usd_foil"],
    "scryfall_id",
  );

  const { rows: notLegalRows } = await pool.query(
    "SELECT scryfall_id FROM card_prints WHERE not_tournament_legal = true",
  );
  const notTournamentLegalIds = new Set(notLegalRows.map((r) => r.scryfall_id));

  const bestByOracle = new Map();
  for (const row of printCacheRows) {
    if (notTournamentLegalIds.has(row.scryfall_id)) continue;
    const entry = bestByOracle.get(row.oracle_id) ?? { normal: null, foil: null };
    if (row.usd != null && (!entry.normal || row.usd < entry.normal.usd)) {
      entry.normal = { usd: row.usd, scryfallId: row.scryfall_id };
    }
    if (row.usd_foil != null && (!entry.foil || row.usd_foil < entry.foil.usd)) {
      entry.foil = { usd: row.usd_foil, scryfallId: row.scryfall_id };
    }
    bestByOracle.set(row.oracle_id, entry);
  }

  const oracleCacheRows = [];
  for (const [oracleId, entry] of bestByOracle) {
    if (!entry.normal && !entry.foil) continue;
    oracleCacheRows.push({
      oracle_id: oracleId,
      date: today,
      scryfall_id: entry.normal?.scryfallId ?? null,
      usd: entry.normal?.usd ?? null,
      jpy_est: entry.normal ? Math.round(entry.normal.usd * rate * 100) / 100 : null,
      scryfall_id_foil: entry.foil?.scryfallId ?? null,
      usd_foil: entry.foil?.usd ?? null,
      jpy_est_foil: entry.foil ? Math.round(entry.foil.usd * rate * 100) / 100 : null,
    });
  }
  console.log(`最安値: ${oracleCacheRows.length}件（オラクル単位）`);

  console.log("card_current_pricesを更新中...");
  await bulkUpsert(
    "card_current_prices",
    oracleCacheRows,
    ["oracle_id", "date", "scryfall_id", "usd", "jpy_est", "scryfall_id_foil", "usd_foil", "jpy_est_foil"],
    "oracle_id",
  );

  console.log("\n完了");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
