/**
 * card_streaks（「継続注目カード」トップページ用、db/schema.sql）を計算する。
 *
 * trending_scores（1日あたり上位10件しか保存しない・直近3日変化ベース）とは別物。
 * こちらは全カード対象に毎日「前日比で実際に何日連続で上がり続けているか」を計算する。
 *
 * 【設計：完全ステートレス】前日分のcard_streaksを一切参照しない。日次バッチ（GitHub Actions、
 * CPU時間制限なし）側で、月次バルクファイルからSTREAK_LOOKBACK_DAYS分を読み、日付ベースで
 * （配列の隣接要素同士ではなく、実際の暦日が連続しているか）当日から遡って毎回ゼロから
 * 計算し直す。
 *
 * 【変遷】最初は「前日分のstreak_days・基準値を引き継いで+1/リセット」という
 * compute-trending-scores.mjsと同じ前日引き継ぎ方式にしたが、これも「前日の値を信頼する」
 * という意味では状態を持ってしまっており、1日でも計算が飛ぶと以降ずっとズレを引きずる
 * リスクが残っていた。「カード自身の価格履歴を見ればstreakは分かるはず」という指摘を受け、
 * 前日の状態を一切見ずに毎回ソースデータから計算し直す方式に変更した
 * （docs/incident-log.md参照）。
 *
 * ランキング/トレンドページ用の事前計算キャッシュ（price-changes/latest.ndjson.gz）は
 * 直近7日分しか持たない（サイト側の毎リクエストで読むファイルなので小さく保つ必要がある）。
 * streak計算はサイトの読み込みパスと無関係なバッチ処理なので、そちらとは別に月次バルク
 * ファイルから必要な日数分（STREAK_LOOKBACK_DAYS）を直接読む。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/compute-card-streaks.mjs
 */

import { monthsBetween, readOraclePriceMonths } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// 実運用上、この日数を超えて連続上昇し続けることはほぼ無い前提。境界に達したカードがいても
// streak_daysが本来より短く出るだけで、安全側に倒れる（誤って長すぎる値を出すことは無い）。
const STREAK_LOOKBACK_DAYS = 30;
const USAGE_PERIOD_DAYS = 7;

const PAGE_SIZE = 1000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

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
    if (!res.ok) throw new Error(`${table} upsert failed (chunk ${i}): ${res.status} ${await res.text()}`);
  }
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

/**
 * date -> value のMapと基準日（today）を受け取り、実際にデータがある観測日を新しい方から
 * 遡りながら「前の観測比プラスが何回連続しているか」を数える。
 *
 * 【変遷】以前は暦日で1日ずつ遡り、途中の日付が欠測していれば即座に打ち切っていた
 * （誤って連続とみなさないための安全策のつもりだった）。しかし2026-08-25/26のように
 * GitHub Actionsのtimeoutで日次バッチ自体が丸ごと欠測した日があると、それ以降ずっと
 * streakが0のままになってしまい、「データはあるのに連続性チェックのせいで出ない」という
 * 状態が続いた（ユーザー指摘、2026-08-27）。欠測日に何が起きたか分からない以上、
 * その日を無かったことにして前後の実データだけで判断する方が実態に近いと判断し、
 * 暦日の連続性チェックをやめ、観測データの並びだけで数えるように変更した。
 */
function computeStreak(valueByDate, todayStr) {
  const todayValue = valueByDate.get(todayStr);
  if (todayValue == null) return null;

  const observedDates = [...valueByDate.keys()].filter((d) => d <= todayStr).sort();
  let days = 0;
  let cursorValue = todayValue;
  for (let i = observedDates.length - 2; i >= 0; i--) {
    const prevValue = valueByDate.get(observedDates[i]);
    if (!(cursorValue > prevValue)) break;
    days++;
    cursorValue = prevValue;
  }
  if (days === 0) return null;
  return { streakDays: days, baseline: cursorValue, latest: todayValue };
}

function changeValueFrom(baseline, latest, asPercent) {
  if (baseline === 0) return null;
  const diff = asPercent ? ((latest - baseline) / baseline) * 100 : latest - baseline;
  return Math.round(diff * 100) / 100;
}

async function main() {
  const today = new Date();
  const todayStr = isoDate(today);
  const sinceStr = addDays(todayStr, -STREAK_LOOKBACK_DAYS);

  const rows = [];

  // ── 価格（フォーマット非依存、全プリント横断の最安値） ──
  const priceRows = (await readOraclePriceMonths(monthsBetween(sinceStr, todayStr))).filter(
    (r) => r.date >= sinceStr && r.jpy_est != null,
  );
  const priceByOracle = new Map(); // oracle_id -> Map<date, value>
  for (const r of priceRows) {
    if (!priceByOracle.has(r.oracle_id)) priceByOracle.set(r.oracle_id, new Map());
    priceByOracle.get(r.oracle_id).set(r.date, Number(r.jpy_est));
  }
  for (const [oracleId, valueByDate] of priceByOracle) {
    const result = computeStreak(valueByDate, todayStr);
    if (!result) continue;
    const changeValue = changeValueFrom(result.baseline, result.latest, true);
    if (changeValue == null) continue;
    rows.push({
      oracle_id: oracleId,
      category: "price",
      format: "ALL",
      calculated_date: todayStr,
      streak_days: result.streakDays,
      change_value: changeValue,
      baseline_value: result.baseline,
    });
  }

  // ── 採用率（フォーマットごとに別値） ──
  const usageRows = await supabaseGet(
    `card_usage_stats?select=oracle_id,format,calculated_at,usage_rate&period_days=eq.${USAGE_PERIOD_DAYS}&calculated_at=gte.${sinceStr}&order=oracle_id.asc,format.asc,calculated_at.asc`,
  );
  const usageByKey = new Map(); // "oracle_id|format" -> Map<date, value>
  for (const r of usageRows) {
    const key = `${r.oracle_id}|${r.format}`;
    if (!usageByKey.has(key)) usageByKey.set(key, new Map());
    usageByKey.get(key).set(r.calculated_at, Number(r.usage_rate));
  }
  for (const [key, valueByDate] of usageByKey) {
    const result = computeStreak(valueByDate, todayStr);
    if (!result) continue;
    const changeValue = changeValueFrom(result.baseline, result.latest, false);
    if (changeValue == null) continue;
    const [oracleId, format] = key.split("|");
    rows.push({
      oracle_id: oracleId,
      category: "usage",
      format,
      calculated_date: todayStr,
      streak_days: result.streakDays,
      change_value: changeValue,
      baseline_value: result.baseline,
    });
  }

  // dbTrendingCards.tsは常に最新のcalculated_dateしか読まないため、過去日分は保持する意味が無い。
  // 削除せず溜め続けるとcard_price_snapshots（削除済み、DB容量超過の原因の一つだった）と
  // 同じ轍を踏むため、当日分以外は全て消してから当日分を入れ直す（=テーブルは常に1日分だけ保持）。
  await supabaseDelete(`card_streaks?calculated_date=neq.${todayStr}`);
  await supabaseDelete(`card_streaks?calculated_date=eq.${todayStr}`);
  await supabaseUpsert("card_streaks", rows, "oracle_id,category,format,calculated_date");
  console.log(`card_streaks 保存: ${rows.length}件（price ${rows.filter((r) => r.category === "price").length}件 / usage ${rows.filter((r) => r.category === "usage").length}件）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
