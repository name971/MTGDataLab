/**
 * R2の価格履歴アーカイブ（price-history/*.ndjson.gz、月次・オラクル単位）をNASの
 * price_historyテーブルへコピーする。既存のscripts/lib/r2PriceArchive.mjsの
 * readOraclePriceMonths()をそのまま再利用する（R2読み取り専用、書き込みは行わない）。
 *
 * 実行: NAS_POSTGRES_URL=... R2_*=... node scripts/copy-price-history-to-nas.mjs
 */
import pg from "pg";
import { monthsUpToToday, readOraclePriceMonths } from "./lib/r2PriceArchive.mjs";

const NAS_POSTGRES_URL = process.env.NAS_POSTGRES_URL;
if (!NAS_POSTGRES_URL) {
  console.error("NAS_POSTGRES_URL を設定してください");
  process.exit(1);
}

async function writeRows(pool, rows) {
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`)
      .join(",");
    const params = chunk.flatMap((r) => [r.oracle_id, r.date, r.jpy_est ?? null, r.jpy_est_foil ?? null]);
    await pool.query(
      `INSERT INTO price_history (oracle_id, date, jpy_est, jpy_est_foil) VALUES ${values}
       ON CONFLICT (oracle_id, date) DO UPDATE SET jpy_est = EXCLUDED.jpy_est, jpy_est_foil = EXCLUDED.jpy_est_foil`,
      params,
    );
  }
}

async function main() {
  const months = monthsUpToToday();
  console.log(`R2から${months.length}ヶ月分（${months[0]}〜${months.at(-1)}）を月ごとに読み込みます`);
  // readOraclePriceMonths([...全月])は全月分を一度にメモリへ載せてOOM（JS heap out of memory）で
  // 落ちた（31ヶ月分、数百万行規模）。1ヶ月ずつ読んで即書き込み、参照を手放すことでメモリ使用量を
  // 一定に保つ。
  const pool = new pg.Pool({ connectionString: NAS_POSTGRES_URL, max: 8 });
  let written = 0;
  for (const month of months) {
    const rows = await readOraclePriceMonths([month]);
    await writeRows(pool, rows);
    written += rows.length;
    console.log(`  ${month}: ${rows.length}行（累計${written}行）`);
  }

  console.log(`\n完了: ${written}行をNASへ書き込み`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
