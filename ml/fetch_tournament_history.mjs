/**
 * TopDeck.gg APIから長期間（デフォルト900日）のトーナメント結果を取得し、
 * scripts/compute-deck-stats.mjsと同じ採用率の定義（フォーマット別、直近7日ローリング窓、
 * メインボードのユニークオラクル数 / その窓の総デッキ数）でml/data/usage_stats.parquet相当の
 * NDJSONをローカルに書き出す。
 *
 * Supabaseのcard_usage_statsは直近60日しか保持しないため、学習用に長期の採用率履歴が
 * 欲しい場合はこのスクリプトでTopDeck.gg APIから直接遡って再計算する。
 * どこにも書き込みは行わない（完全ローカル。クラウド課金とは無関係）。
 *
 * 各行にはそのデッキの勝率（win_rate、wins/(wins+losses+draws)。データが無い大会は
 * null）も含める。アーキタイプ分類（MTGOFormatDataのルール未整備のため未実装）を
 * 経由せず、「勝っているデッキで使われているカードは今後採用率が上がりやすい」という
 * 先行指標をカード単位で直接作れるようにするため。
 *
 * 各オラクル行にはそのデッキでの投入枚数（quantity）も含める。今までの採用率は
 * 「1枚でも入っているか」の有無だけで、4枚フル投入のコア戦略カードも1枚だけの
 * タッチ採用も同じ扱いだったため、平均投入枚数を別特徴量として作れるようにする。
 *
 * TopDeck.gg APIの生レスポンスはml/data/topdeck_raw_cache/にチャンク単位でキャッシュ
 * する（レート制限が厳しく取得に時間がかかるため、後から処理内容を変えたくなった時に
 * 再アクセス不要にする）。
 *
 * 実行: TOPDECK_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *       node ml/fetch_tournament_history.mjs [lastDays]
 * 出力: ml/data/tournament_usage_history.ndjson
 *       （このあとml/build_usage_history_from_tournaments.pyでusage_stats.parquetへ変換する）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureBulkData, loadIndex, findEnglishCard, frontFaceName } from "../scripts/lib/scryfallBulk.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// TopDeck.gg APIの生レスポンスをチャンク単位でキャッシュする（レート制限が厳しく
// 900日分の取得に時間がかかるため、後から勝敗集計など処理内容を変えたくなった時に
// APIへ再アクセスしなくて済むようにする）。
const RAW_CACHE_DIR = join(__dirname, "data", "topdeck_raw_cache");

const TOPDECK_API_KEY = process.env.TOPDECK_API_KEY;
if (!TOPDECK_API_KEY) {
  console.error("TOPDECK_API_KEY を設定してください");
  process.exit(1);
}

const LAST_DAYS = parseInt(process.argv[2] ?? "900", 10);
// 1リクエストあたりの日数。Commanderは16,000件超と桁違いに重く、last=900のような大きな
// 一括リクエストだとTopDeck側が502（Cloudflareのゲートウェイエラー）を返し続けたため、
// 全フォーマット共通でstart/end（unix秒）による日付範囲チャンクに分割する
// （last単独だと「今日からN日前まで」しか指定できず、過去の範囲を狙い撃ちできないため）。
const CHUNK_DAYS = 90;
// Commanderは1チャンクあたりのトーナメント数が他フォーマットの数十倍あり、90日でも
// まだ502が出るため、さらに細かく分割する。
const CHUNK_DAYS_BY_FORMAT = { Commander: 20 };
// チャンク間に間隔を空けないと、連続POSTでTopDeck側のレート制限（429）に引っかかる。
const CHUNK_INTERVAL_MS = 1500;

// src/lib/formats.ts と同じ一覧。TopDeck.gg側の表記が違うものだけ変換する
const FORMATS = ["Standard", "Pioneer", "Modern", "Legacy", "Vintage", "Commander"];
const FORMAT_ALIASES = { Commander: "EDH" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDateChunks(totalDays, chunkDays) {
  // 秒単位のDate.now()をそのまま基準にすると、実行するたびにチャンク境界が数秒〜数時間
  // ずれてキャッシュファイル名が一致しなくなる（rawCachePathがstart/endを含むため）。
  // UTCの日付境界に固定することで、同じ日のうちの再実行は必ずキャッシュにヒットする。
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const nowSec = Math.floor(today.getTime() / 1000);
  const chunks = [];
  for (let daysAgo = totalDays; daysAgo > 0; daysAgo -= chunkDays) {
    const start = nowSec - daysAgo * 86400;
    const end = nowSec - Math.max(daysAgo - chunkDays, 0) * 86400;
    chunks.push({ start, end });
  }
  return chunks;
}

function rawCachePath(format, start, end) {
  return join(RAW_CACHE_DIR, `${format}_${start}_${end}.json`);
}

async function fetchTournamentsChunk(format, start, end, { retries = 5 } = {}) {
  const cachePath = rawCachePath(format, start, end);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }

  const topdeckFormat = FORMAT_ALIASES[format] ?? format;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch("https://topdeck.gg/api/v2/tournaments", {
      method: "POST",
      headers: { Authorization: TOPDECK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        game: "Magic: The Gathering",
        format: topdeckFormat,
        start,
        end,
        // import-tournaments.mjsと同じcolumns指定に合わせる（deckObjだけだとstandingsが
        // 空で返ってくることを確認済み）
        columns: ["name", "decklist", "deckObj", "wins", "draws", "losses"],
      }),
    });
    if (res.ok) {
      const body = await res.json();
      mkdirSync(RAW_CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(body));
      return body;
    }
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const retryAfter = (body.retryAfterSeconds ?? 5) * 1000 + 500;
      console.log(`    429（レート制限）、${retryAfter}ms待って再試行 ${attempt}/${retries}...`);
      await sleep(retryAfter);
      continue;
    }
    // 502/504はCloudflare側の一時的なゲートウェイエラーで再試行すれば通ることが多い。
    // それ以外のエラーは即座に諦める。
    if (res.status !== 502 && res.status !== 504) {
      throw new Error(`TopDeck API failed（${format}）: ${res.status} ${await res.text()}`);
    }
    console.log(`    ${res.status}エラー、リトライ ${attempt}/${retries}...`);
    await sleep(attempt * 5000);
  }
  throw new Error(`TopDeck API failed（${format}）: ${retries}回リトライしても失敗`);
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

  const outPath = join(__dirname, "data", "tournament_usage_history.ndjson");
  writeFileSync(outPath, ""); // 前回分をクリアして毎回作り直す

  const unresolvedCounter = { count: 0 };
  let deckCount = 0;
  let totalRowCount = 0;

  for (const format of FORMATS) {
    const chunkDays = CHUNK_DAYS_BY_FORMAT[format] ?? CHUNK_DAYS;
    const dateChunks = buildDateChunks(LAST_DAYS, chunkDays);
    console.log(`TopDeck.gg: ${format}（TopDeck表記: ${FORMAT_ALIASES[format] ?? format}）直近${LAST_DAYS}日を${chunkDays}日ずつ取得中...`);

    let formatRowCount = 0;
    let formatTournamentCount = 0;
    let formatWithDecklistCount = 0;

    for (const { start, end } of dateChunks) {
      let tournaments;
      try {
        tournaments = await fetchTournamentsChunk(format, start, end);
      } catch (err) {
        // 1チャンクが失敗しても、他チャンク・他フォーマット分は残す
        console.error(`  ${format}（${new Date(start * 1000).toISOString().slice(0, 10)}〜${new Date(end * 1000).toISOString().slice(0, 10)}）: 取得失敗、スキップします（${err.message}）`);
        await sleep(CHUNK_INTERVAL_MS);
        continue;
      }
      await sleep(CHUNK_INTERVAL_MS);

      formatTournamentCount += tournaments.length;
      const withDecklists = tournaments.filter((t) => (t.standings ?? []).some((s) => s.deckObj));
      formatWithDecklistCount += withDecklists.length;

      // 巨大な配列を最後に1回でJSON.stringify().join()すると文字列長上限
      // （RangeError: Invalid string length、Commanderで実際に発生）を超えるため、
      // チャンクごと・行ごとに逐次appendする。
      let chunkLines = "";
      for (const t of withDecklists) {
        const eventDate = new Date(t.startDate * 1000).toISOString().slice(0, 10);
        let standingIndex = 0;
        for (const standing of t.standings ?? []) {
          if (!standing.deckObj) continue;
          deckCount++;
          // 総デッキ数の集計に使う一意なdeck_id（TopDeck側にデッキ単位のIDが無いため合成する）
          const deckId = `${t.TID}#${standingIndex++}`;

          // oracle_id -> そのデッキでの投入枚数（board別。同じオラクルの別プリントが
          // 両方投入されているケースはほぼ無いはずだが、念のため合算する）
          const mainOracleQuantities = new Map();
          const sideOracleQuantities = new Map();
          for (const [boardName, cards] of Object.entries(standing.deckObj)) {
            if (boardName === "metadata") continue;
            const boardLower = boardName.toLowerCase();
            // commander欄（EDHの統率者）はメインともサイドとも性質が違うため両方から除外
            if (boardLower.startsWith("commander")) continue;
            // サイドボードは対策カードだけでなく汎用的な回答カードも多く、除外すると
            // その需要シグナルが完全に見えなくなる（2026-08-16、ユーザー指摘）。
            // メインボードとは別枠（sideboard_usage_rate_max）として残し、メイン採用率
            // とは区別して特徴量にする。
            const isSideboard = boardLower.startsWith("side");
            const target = isSideboard ? sideOracleQuantities : mainOracleQuantities;
            for (const [cardName, info] of Object.entries(cards)) {
              const oracleId = resolveOracleId(index, cardName, unresolvedCounter);
              if (!oracleId) continue;
              const quantity = Number(info?.count) || 1;
              target.set(oracleId, (target.get(oracleId) ?? 0) + quantity);
            }
          }
          // 勝率（アーキタイプ分類が無いため、デッキ単位の勝率をカードに直接ひも付けて
          // 「勝っているデッキで使われているカードは今後採用率が上がりやすい」という
          // 先行指標を作る。wins/losses/drawsが無い大会もあるためnullを許容する）
          const wins = standing.wins ?? null;
          const losses = standing.losses ?? null;
          const draws = standing.draws ?? null;
          const totalGames = wins != null && losses != null ? wins + losses + (draws ?? 0) : null;
          const winRate = totalGames && totalGames > 0 ? wins / totalGames : null;

          // oracle_id: null の行はデッキ自体の存在を表す（採用カードが1枚も解決できなかった
          // デッキでも、総デッキ数の分母には数える必要があるため）
          chunkLines += JSON.stringify({ format, event_date: eventDate, deck_id: deckId, oracle_id: null, win_rate: winRate, quantity: null, board: "main" }) + "\n";
          formatRowCount++;
          for (const [oracleId, quantity] of mainOracleQuantities) {
            chunkLines += JSON.stringify({ format, event_date: eventDate, deck_id: deckId, oracle_id: oracleId, win_rate: winRate, quantity, board: "main" }) + "\n";
            formatRowCount++;
          }
          for (const [oracleId, quantity] of sideOracleQuantities) {
            chunkLines += JSON.stringify({ format, event_date: eventDate, deck_id: deckId, oracle_id: oracleId, win_rate: winRate, quantity, board: "side" }) + "\n";
            formatRowCount++;
          }
        }
      }
      if (chunkLines) appendFileSync(outPath, chunkLines);
    }

    totalRowCount += formatRowCount;
    console.log(`  ${formatTournamentCount}件中 ${formatWithDecklistCount}件にデッキリストあり`);
    console.log(`  ${format}: ${formatRowCount}行を書き出し済み`);
  }

  console.log(
    `\n完了: ${deckCount}デッキ、${totalRowCount}行（未解決カード名 ${unresolvedCounter.count}件、無視）`,
  );
  console.log(`書き出し先: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
