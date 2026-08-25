/**
 * サイト全体の読み込み速度をLighthouseでまとめてチェックする使い回しツール。
 * 「コマンダーへの切り替えが遅い」のような個別ページの体感速度問題を都度手動計測していたため、
 * 主要ページを一括で回して悪い順に並べられる形にした（2026-08-26）。
 *
 * 実行: node scripts/check-page-speed.mjs [baseUrl]
 *   baseUrl省略時は http://localhost:3000（`npm run build && npm run start`等で起動しておくこと）
 *   動的ルート（/cards/[oracleId]等）はROUTESの実例IDを実際のデータに差し替えてから使う。
 *
 * 初回はnpxがlighthouseを自動ダウンロードする。ローカルのChrome/Edgeを使うため別途ブラウザが必要。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.argv[2] ?? "http://localhost:3000";

// 動的ルートは代表的なIDに差し替えて使う（DBの中身に依存するため固定値はここでは仮）
const ROUTES = [
  "/",
  "/banned-cards",
  "/decks",
  "/decks?format=commander",
  "/packs",
  "/search",
  "/search/advanced",
  // "/cards/<oracleId>",
  // "/decks/<deckId>",
  // "/decks/archetype/<archetypeId>",
  // "/rankings/<format>",
];

const OUT_DIR = path.join(process.cwd(), ".cache", "lighthouse-reports");
mkdirSync(OUT_DIR, { recursive: true });

function runLighthouse(url) {
  const outPath = path.join(OUT_DIR, encodeURIComponent(url) + ".json");
  try {
    execFileSync(
      "npx",
      [
        "lighthouse",
        url,
        "--output=json",
        `--output-path=${outPath}`,
        "--chrome-flags=--headless=new",
        "--only-categories=performance",
        "--quiet",
      ],
      { stdio: ["ignore", "ignore", "pipe"], shell: true },
    );
  } catch (err) {
    // ChromeのプロファイルディレクトリをChrome起動時ロックしたままの権限で作った場合、
    // 計測自体は完了していてもLighthouse終了時のtmpディレクトリ削除がEPERMで失敗し、
    // execFileSyncが非ゼロ終了として例外を投げることがある（Windowsで確認）。
    // レポート自体は書き出し済みのことが多いので、ファイルが無い場合だけ本当の失敗とする。
    if (!existsSync(outPath)) throw err;
  }
  return JSON.parse(readFileSync(outPath, "utf8"));
}

function main() {
  const results = [];
  for (const route of ROUTES) {
    const url = BASE_URL + route;
    process.stderr.write(`計測中: ${url}\n`);
    try {
      const report = runLighthouse(url);
      const audits = report.audits;
      results.push({
        route,
        score: Math.round((report.categories.performance.score ?? 0) * 100),
        lcpMs: Math.round(audits["largest-contentful-paint"]?.numericValue ?? 0),
        tbtMs: Math.round(audits["total-blocking-time"]?.numericValue ?? 0),
        cls: Number((audits["cumulative-layout-shift"]?.numericValue ?? 0).toFixed(3)),
        totalKb: Math.round((audits["total-byte-weight"]?.numericValue ?? 0) / 1024),
      });
    } catch (err) {
      results.push({ route, error: String(err.message ?? err) });
    }
  }

  results.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

  console.log("\n=== ページ速度チェック結果（スコアが低い順） ===");
  console.log(`基準URL: ${BASE_URL}\n`);
  for (const r of results) {
    if (r.error) {
      console.log(`${r.route}: 失敗 (${r.error})`);
      continue;
    }
    console.log(
      `[${r.score.toString().padStart(3)}点] ${r.route}  LCP=${r.lcpMs}ms  TBT=${r.tbtMs}ms  CLS=${r.cls}  合計${r.totalKb}KB`,
    );
  }
  console.log(`\n詳細JSONは ${OUT_DIR} に保存済み（各レポートのaudits配下に改善提案あり）`);
}

main();
