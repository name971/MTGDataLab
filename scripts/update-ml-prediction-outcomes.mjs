/**
 * card_price_predictions（ml/predict_and_publish.pyが書き込む注目カードランキングの予測）に、
 * 「予測時点(calculated_at)から7日以内でどれだけ動いたか」を追記する。
 *
 * - current_pct_change: 直近の実績価格が予測時点からどれだけ変化したか（7日を過ぎたら
 *   7日目時点の値で固定される。predict_and_publish.pyは手動運用のため、次のバッチが
 *   しばらく実行されないとこのスクリプトが同じcalculated_at分を何度も再実行することになり、
 *   7日という上限が無いと「7日後の価格変動」のはずが無期限に動き続けてしまうため、
 *   2026-09-17に修正した）
 * - extreme_pct_change: 予測時点〜7日後までの間で一番良かった結果（direction沿い）。
 *   upは最大値（マイナスの最大＝実は下落、を拾わないよう必ず最大を採る）、
 *   downは最小値（同様にプラスの最大を拾わないよう必ず最小を採る）。
 *
 * 対象は最新calculated_at分のみ（サイトが表示するのはそこだけのため）。価格履歴は
 * オラクル単位ファイル（R2 oracle-history/{oracleId}.ndjson.gz）を1オラクル1回読む
 * （scripts/lib/r2PriceArchive.mjs、月次ファイル全件走査より軽い）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/update-ml-prediction-outcomes.mjs
 */

import { readOracleCardFile, runWithConcurrency } from "./lib/r2PriceArchive.mjs";

// ml/features.pyのTARGET_HORIZON_DAYS（予測が「7日後」を対象にしている）と揃える
const OUTCOME_WINDOW_DAYS = 7;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePatch(oracleId, direction, calculatedAt, body) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/card_price_predictions?oracle_id=eq.${oracleId}&direction=eq.${direction}&calculated_at=eq.${calculatedAt}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`PATCH failed: ${res.status} ${await res.text()}`);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** "2026-09-10" + 7日 -> "2026-09-17" */
function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const [latestRow] = await supabaseGet(
    "card_price_predictions?select=calculated_at&order=calculated_at.desc&limit=1",
  );
  if (!latestRow) {
    console.log("card_price_predictionsが空のため終了");
    return;
  }
  const calculatedAt = latestRow.calculated_at;
  const windowEnd = addDays(calculatedAt, OUTCOME_WINDOW_DAYS);

  const rows = await supabaseGet(
    `card_price_predictions?select=oracle_id,direction,jpy_est&calculated_at=eq.${calculatedAt}`,
  );
  console.log(`対象: ${calculatedAt} 分 ${rows.length}件`);

  let updated = 0;
  let skipped = 0;
  await runWithConcurrency(rows, 8, async (row) => {
    const baseline = Number(row.jpy_est);
    if (!baseline) {
      skipped++;
      return;
    }
    const history = await readOracleCardFile(row.oracle_id);
    const windowRows = history
      .filter((r) => r.date >= calculatedAt && r.date <= windowEnd && r.jpy_est != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (windowRows.length === 0) {
      skipped++;
      return;
    }

    const pctChanges = windowRows.map((r) => ((Number(r.jpy_est) - baseline) / baseline) * 100);
    const latestPct = pctChanges[pctChanges.length - 1];
    // direction沿いの「一番良い結果」。upはマイナスの最大（＝実は下落）を拾わないよう必ずmax、
    // downはプラスの最大を拾わないよう必ずmin（ユーザー指摘、2026-08-29）。
    const extremePct = row.direction === "up" ? Math.max(...pctChanges) : Math.min(...pctChanges);

    await supabasePatch(row.oracle_id, row.direction, calculatedAt, {
      current_pct_change: round2(latestPct),
      extreme_pct_change: round2(extremePct),
    });
    updated++;
  });

  console.log(`完了: ${updated}件更新、${skipped}件は価格履歴なしでスキップ`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
