/**
 * 価格履歴アーカイブ用R2（jp-mtgstocks-price-archive）へのNode.js側アクセス。
 * D1（price_history_archive/print_price_history_archive）の代わりに、日次の実データ書き込み・
 * 古いSupabase行の吸い出し・バッチ集計の読み込みをすべてここ経由でR2に対して行う
 * （D1は無料枠の読み書き行数上限に達したため、リクエスト数課金のR2へ全面移行した）。
 *
 * 2種類のレイアウトを併用する:
 *   - 月次ファイル（price-history/print-price-history、全カード横断のYYYY-MM.ndjson.gz）:
 *     compute-card-streaks.mjs/compute-trending-scores.mjs等、全カードを横断的に走査する
 *     バッチ集計（CPU時間制限の無いGitHub Actions側）専用。
 *   - カード単位ファイル（oracle-history/print-history、{id}.ndjson.gz）: サイト側
 *     （Cloudflare Workers、無料枠でリクエストあたりCPU時間10ms）が1枚のカードの価格推移を
 *     表示する際に使う。月次ファイル全部（30ヶ月分、各5〜8MB圧縮）を毎回読むとCPU時間制限を
 *     超過する恐れがあるため、1回のGetObjectで完結するこちらを読む
 *     （src/lib/priceArchiveR2.ts参照）。日次バッチは両方へ書き込む。
 */

// libuvのスレッドプール（zlib等の非同期処理が実際に並列実行される場所）はデフォルト4スレッド
// までしか無く、runWithConcurrencyの並列数（16）を活かしきれない。プールは初回使用時に
// 遅延初期化されるため、他のどのzlib呼び出しよりも前（このモジュールの読み込み時）に
// 設定すれば間に合う。
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "32";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

// gzipSync/gunzipSyncはNode.jsのシングルスレッドイベントループを圧縮・展開の間ずっと止める。
// runWithConcurrencyで「16並列」のつもりで呼んでも、どれか1件が同期gzip処理に入った瞬間、
// 他の15件も含めて全部が止まり、ネットワーク待ちの重なりだけが並列化されてCPU律速の圧縮処理は
// 実質直列化されていた（実際に1万件規模のバックフィルで大幅な遅延が発生した）。非同期版なら
// libuvのスレッドプールに逃がせるため、他の非同期I/Oをブロックしない。
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const R2_PRICE_PREFIX = "price-history"; // 月次、(oracle_id, date, jpy_est, jpy_est_foil?, scryfall_id?, scryfall_id_foil?)
const R2_PRINT_PRICE_PREFIX = "print-price-history"; // 月次、(scryfall_id, date, usd, usd_foil?)
const R2_ORACLE_CARD_PREFIX = "oracle-history"; // カード単位、1オラクル1ファイル
const R2_PRINT_CARD_PREFIX = "print-history"; // カード単位、1プリント1ファイル
// ml/fetch_tcgcsv_history.pyのARCHIVE_START_DATEと同じ（R2の実際の最古データ）
export const ARCHIVE_MONTHS_START = "2024-02";

let client = null;
function r2Client() {
  if (client) return client;
  client = new S3Client({
    endpoint: process.env.R2_ENDPOINT_URL,
    region: "auto",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

function bucketName() {
  const name = process.env.R2_BUCKET_NAME;
  if (!name) throw new Error("R2_BUCKET_NAME を設定してください");
  return name;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ARCHIVE_MONTHS_STARTから今日までの"YYYY-MM"一覧を古い順に返す */
export function monthsUpToToday() {
  const months = [];
  const [startYear, startMonth] = ARCHIVE_MONTHS_START.split("-").map(Number);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const now = new Date();
  while (cursor <= now) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function readNdjsonGz(key) {
  try {
    const res = await r2Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    const gz = await streamToBuffer(res.Body);
    const text = (await gunzipAsync(gz)).toString("utf-8");
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      // 一部の書き込み元でJSON.stringify(NaN)相当の不正な"NaN"トークンが混入することがある
      // （2026-08分で実際に発生、原因未特定）。JSON非準拠のためJSON.parseが失敗する箇所を
      // nullへ寄せて読み進められるようにする（書き込み側の根本修正は別途必要）。
      rows.push(JSON.parse(line.replace(/:\s*NaN\b/g, ": null")));
    }
    return rows;
  } catch (err) {
    if (err?.name === "NoSuchKey") return [];
    throw err;
  }
}

async function writeNdjsonGz(key, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const gz = await gzipAsync(Buffer.from(body, "utf-8"));
  await r2Client().send(new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: gz }));
}

function readMonthFile(prefix, month) {
  return readNdjsonGz(`${prefix}/${month}.ndjson.gz`);
}

function writeMonthFile(prefix, month, rows) {
  return writeNdjsonGz(`${prefix}/${month}.ndjson.gz`, rows);
}

/** R2上の月次ファイルへnewRowsをマージして書き戻す（(idColumn, date)重複は新しい値で上書き）。 */
async function mergeMonthFile(prefix, month, newRows, idColumn) {
  const existing = await readMonthFile(prefix, month);
  const byKey = new Map(existing.map((r) => [`${r[idColumn]} ${r.date}`, r]));
  for (const r of newRows) byKey.set(`${r[idColumn]} ${r.date}`, r);
  const merged = [...byKey.values()].sort((a, b) =>
    a[idColumn] === b[idColumn] ? a.date.localeCompare(b.date) : a[idColumn].localeCompare(b[idColumn]),
  );
  await writeMonthFile(prefix, month, merged);
  return merged.length;
}

/**
 * 限られた同時実行数でPromiseを返す関数の配列を処理する（R2への大量リクエスト用）。
 * R2側の一時的なエラー（5xx等、AWS SDKの内部リトライを使い切っても失敗することがある）で
 * 1件失敗しても、数万件規模の処理全体を巻き込んで止めない。失敗した項目はログに出すだけで
 * 継続し、呼び出し元には失敗件数を返す（0件なら全件成功）。
 */
export async function runWithConcurrency(items, concurrency, fn) {
  const queue = [...items];
  let failed = 0;
  async function worker() {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try {
        await fn(item);
      } catch (err) {
        failed++;
        console.error(`  ...1件失敗（続行）: ${err?.message ?? err}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return failed;
}

/**
 * カード単位ファイルへ1枚分のnewRowsをマージして書き戻す（日付重複は新しい値で上書き）。
 * newRowsの内容が既存データと完全に同じ（前日と値が変わっていない等）場合はPUTしない。
 * scripts/snapshot-catalog-prices.mjsのように「変化の有無をチェックせず毎日全件渡す」
 * 呼び出し元でも、実際に変化した分だけがR2への書き込み（Class A、無料枠100万件/月）を
 * 消費するようにするため（GET自体は読み取り無料枠10,000,000件/月に対して余裕がある）。
 */
async function mergeCardFile(prefix, cardId, newRows) {
  const existing = await readNdjsonGz(`${prefix}/${cardId}.ndjson.gz`);
  const byDate = new Map(existing.map((r) => [r.date, r]));
  let changed = existing.length === 0;
  for (const r of newRows) {
    const prev = byDate.get(r.date);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(r)) changed = true;
    byDate.set(r.date, r);
  }
  if (!changed) return;
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeNdjsonGz(`${prefix}/${cardId}.ndjson.gz`, merged);
}

/** カード単位でグルーピングしたrowsを、それぞれのカードファイルへマージ書き込みする。 */
async function mergeCardFiles(prefix, rows, idColumn, concurrency = 16) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r[idColumn])) byId.set(r[idColumn], []);
    byId.get(r[idColumn]).push(r);
  }
  const failed = await runWithConcurrency([...byId.entries()], concurrency, ([cardId, cardRows]) =>
    mergeCardFile(prefix, cardId, cardRows),
  );
  if (failed > 0) console.error(`  ${prefix}: ${failed}/${byId.size}件が失敗しました（続行済み）`);
  return byId.size;
}

// mergeOracle/PrintPriceRowsを1プロセス内で何度も呼ぶと、呼び出し回数分だけほぼ全カードの
// ファイルへGET+PUTが繰り返される（1回にまとめれば済むはずの書き込みが、ループの回数倍だけ
// 無駄になる）。実際に2026-08-15だけで2回、「月ごと・ページごとにこの関数を呼ぶ」設計ミスで
// 数時間分の処理時間を無駄にした（docs/incident-log.md参照）。「気をつける」だけでは
// 同じミスを繰り返したため、呼び出し回数を実行時に数え、閾値を超えたら例外を投げて
// 即座に気づけるようにする（「全月分をメモリに溜めてから最後に1回だけ呼ぶ」が正しい使い方）。
let mergeCallCount = 0;
const MERGE_CALL_WARN_THRESHOLD = 3;
function guardAgainstRepeatedMergeCalls(fnName) {
  mergeCallCount++;
  if (mergeCallCount === MERGE_CALL_WARN_THRESHOLD) {
    throw new Error(
      `${fnName}が同一プロセス内で${MERGE_CALL_WARN_THRESHOLD}回呼ばれました。ループ（月ごと・` +
        `ページごと等）の中でこの関数を呼んでいませんか？ 1回の呼び出しでほぼ全カードの` +
        `ファイルにGET+PUTが発生するため、複数回呼ぶとその回数倍だけ時間を無駄にします。` +
        `全データをためてから最後に1回だけ呼んでください（docs/incident-log.md参照）。` +
        `意図的に複数回呼ぶ必要がある場合のみ、この閾値を見直してください。`,
    );
  }
}

/**
 * オラクル単位の価格行を、月次ファイル＋カード単位ファイルの両方へマージ書き込みする。
 * 行の日付が複数月にまたがっていてもよい（月ごとにグルーピングしてから書き込む）。
 * 呼び出し元は、複数月・複数ページにまたがるデータを全部集めてから1回だけ呼ぶこと
 * （ループの中で呼ばない）。
 */
export async function mergeOraclePriceRows(rows) {
  guardAgainstRepeatedMergeCalls("mergeOraclePriceRows");
  await mergeRowsGroupedByMonth(R2_PRICE_PREFIX, rows, "oracle_id");
  const cardCount = await mergeCardFiles(R2_ORACLE_CARD_PREFIX, rows, "oracle_id");
  console.log(`  R2（${R2_ORACLE_CARD_PREFIX}）へカード単位で書き込み: ${cardCount}件`);
}

/**
 * プリント単位の価格行を、月次ファイル＋カード単位ファイルの両方へマージ書き込みする。
 * mergeOraclePriceRowsと同様、ループの中で呼ばず全データをためてから1回だけ呼ぶこと。
 */
export async function mergePrintPriceRows(rows) {
  guardAgainstRepeatedMergeCalls("mergePrintPriceRows");
  await mergeRowsGroupedByMonth(R2_PRINT_PRICE_PREFIX, rows, "scryfall_id");
  const cardCount = await mergeCardFiles(R2_PRINT_CARD_PREFIX, rows, "scryfall_id");
  console.log(`  R2（${R2_PRINT_CARD_PREFIX}）へカード単位で書き込み: ${cardCount}件`);
}

/**
 * 月次ファイル側は既に正しい一方、カード単位ファイルだけが古い/欠けている場合の復旧用
 * （2026-08-20、ml/fetch_tcgcsv_history.pyが月次ファイルにしか書いておらずカード単位
 * ファイルが空のままだった問題、docs/incident-log.md参照）。月ごとに呼ぶ前提のため、
 * guardAgainstRepeatedMergeCallsは適用しない。
 */
export async function readPrintPriceMonth(month) {
  return readMonthFile(R2_PRINT_PRICE_PREFIX, month);
}

/**
 * プリント単位ファイルを、GETによるマージをせず直接上書きする（呼び出し元が既に全期間分の
 * 行を集約済みで、既存ファイルを読む必要が無い場合専用。通常はmergeCardFile相当を使うこと）。
 */
export async function writePrintCardFileDirect(scryfallId, rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  await writeNdjsonGz(`${R2_PRINT_CARD_PREFIX}/${scryfallId}.ndjson.gz`, sorted);
}

/**
 * プリント単位ファイルを、既存の内容とGETでマージしてから書き戻す（差分更新用）。
 * 全期間分を再構築するwritePrintCardFileDirectと違い、一部の月だけ更新したい場合は
 * こちらを使う（scripts/rebuild-print-history-cards.mjs --months=YYYY-MM参照）。
 */
export async function mergePrintCardFile(scryfallId, newRows) {
  const key = `${R2_PRINT_CARD_PREFIX}/${scryfallId}.ndjson.gz`;
  const existing = await readNdjsonGz(key);
  const byDate = new Map(existing.map((r) => [r.date, r]));
  for (const r of newRows) byDate.set(r.date, r);
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeNdjsonGz(key, merged);
}

export async function readOraclePriceMonth(month) {
  return readMonthFile(R2_PRICE_PREFIX, month);
}

/** オラクル単位ファイルを、既存の内容とGETでマージしてから書き戻す（差分更新用、mergePrintCardFile参照）。 */
export async function mergeOracleCardFile(oracleId, newRows) {
  const key = `${R2_ORACLE_CARD_PREFIX}/${oracleId}.ndjson.gz`;
  const existing = await readNdjsonGz(key);
  const byDate = new Map(existing.map((r) => [r.date, r]));
  for (const r of newRows) byDate.set(r.date, r);
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  await writeNdjsonGz(key, merged);
}

async function mergeRowsGroupedByMonth(prefix, rows, idColumn) {
  const byMonth = new Map();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }
  for (const [month, monthRows] of byMonth) {
    const total = await mergeMonthFile(prefix, month, monthRows, idColumn);
    console.log(`  R2へ書き込み: ${prefix}/${month}.ndjson.gz（${monthRows.length}行追加、計${total}行）`);
  }
}

/** オラクル単位の価格履歴を、指定した月範囲（YYYY-MM文字列の配列）分だけ読み込む（バッチ集計用）。 */
export async function readOraclePriceMonths(months) {
  const perMonth = await Promise.all(months.map((m) => readMonthFile(R2_PRICE_PREFIX, m)));
  return perMonth.flat();
}

/** プリント単位の価格履歴を、指定した月範囲分だけ読み込む（バッチ集計用）。 */
export async function readPrintPriceMonths(months) {
  const perMonth = await Promise.all(months.map((m) => readMonthFile(R2_PRINT_PRICE_PREFIX, m)));
  return perMonth.flat();
}

const R2_RECENT_CHANGES_KEY = "price-changes/latest.ndjson.gz";

/**
 * 全オラクル分の「直近価格＋3日前比の変化率」を1つの小さいファイルにまとめて書き込む。
 * ランキング/トレンドページ（src/lib/dbCardRanking.ts等）が必要とするのは日別の時系列
 * ではなく、オラクルごとのこの2値だけなので、日次バッチ側（CPU時間制限の無いGitHub Actions）
 * で計算しておき、サイト側は1回のGetObjectで全オラクル分を読めるようにする。
 * オラクルごとに個別ファイルを読むと（cardごとのoracle-history/{id}.ndjson.gz）、
 * 100件规模でもRound-trip回数がそのまま増えて数秒〜十数秒かかっていた。
 */
export async function writeRecentPriceChanges(rows) {
  await writeNdjsonGz(R2_RECENT_CHANGES_KEY, rows);
}

/**
 * writeRecentPriceChangesが書いた内容を読み戻す。1回のGetObjectで全オラクル分の
 * 「今日の価格＋直近7日分の系列」が手に入るため、compute-card-streaks.mjsの連続上昇日数
 * 計算はこれを使う（60日分を月次ファイルからスキャンする方式から移行、
 * scripts/compute-card-streaks.mjsのコメント参照）。
 */
export async function readRecentPriceChanges() {
  return readNdjsonGz(R2_RECENT_CHANGES_KEY);
}

/** "YYYY-MM-DD"同士の間の"YYYY-MM"一覧（両端月を含む）を古い順に返す。 */
export function monthsBetween(sinceStr, untilStr) {
  const months = [];
  const cursor = new Date(`${sinceStr.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${untilStr.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= end) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
