/**
 * 日次パイプラインの最後に、主要な集計データが「静かに壊れていないか」をまとめてチェックする。
 * pack_slot_avg_priceの参照テーブルが古いままになりmatch_rateが17〜23%まで落ちていた事故
 * （気づくまで発覚が遅れた）がきっかけで追加した。check-db-size.mjsと同じパターンで、
 * 閾値割れをログとGitHub Actionsのジョブサマリーに警告として出すだけに留める
 * （自動修復はしない。原因調査・修正は手動で行う想定）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/check-data-health.mjs
 */

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

const today = new Date().toISOString().slice(0, 10);
const warnings = [];

/** チェック1件を実行し、閾値割れならwarningsに積む。個別チェックの失敗が他のチェックを止めないようtry/catchで囲む */
async function check(name, fn) {
  try {
    const result = await fn();
    if (result) {
      console.warn(`⚠️ ${name}: ${result}`);
      warnings.push(`⚠️ **${name}**: ${result}`);
    } else {
      console.log(`✓ ${name}`);
    }
  } catch (err) {
    console.warn(`⚠️ ${name}: チェック自体が失敗（${err.message}）`);
    warnings.push(`⚠️ **${name}**: チェック自体が失敗（${err.message}）`);
  }
}

async function main() {
  await check("パックEVのマッチ率（pack_slot_avg_prices）", async () => {
    const rows = await supabaseGet(`pack_slot_avg_prices?calculated_at=eq.${today}&select=match_rate`);
    if (rows.length === 0) return `本日(${today})分の行が無い（compute-pack-slot-avg-prices.mjsが失敗した可能性）`;
    const avg = rows.reduce((s, r) => s + Number(r.match_rate), 0) / rows.length;
    if (avg < 0.8) return `平均${(avg * 100).toFixed(1)}%（${rows.length}件）。参照テーブルがズレている等の可能性`;
    return null;
  });

  await check("採用率データ（card_usage_stats）の鮮度", async () => {
    const rows = await supabaseGet(
      "card_usage_stats?select=calculated_at&order=calculated_at.desc&limit=1",
    );
    if (rows.length === 0) return "データが1件も無い";
    const latest = rows[0].calculated_at;
    if (latest < today) return `最新が${latest}（本日${today}分がまだ無い）`;
    return null;
  });

  await check("継続注目カード（card_streaks）の本日分", async () => {
    const rows = await supabaseGet("card_streaks?calculated_date=eq." + today + "&select=oracle_id&limit=1");
    if (rows.length === 0) return `本日(${today})分の行が無い`;
    return null;
  });

  // Standardで特定フォーマットだけ数日分の取り込みが丸ごと抜け落ち、GitHub Actionsの
  // continue-on-error:trueでジョブが「success」表示のまま誰も気づけなかった事故が実際に
  // 起きたため追加。Commanderはmtgo.comでカバーされずTopDeck.gg（未来日程の事前登録イベントも
  // 混じる）のみが頼りで、この鮮度チェックが意味を持たないため対象外にする。
  await check("トーナメント取り込みの鮮度（フォーマット別）", async () => {
    const rows = await supabaseGet("tournaments?select=format,event_date&order=event_date.desc");
    const latestByFormat = new Map();
    for (const r of rows) {
      if (!latestByFormat.has(r.format)) latestByFormat.set(r.format, r.event_date);
    }
    const STALE_THRESHOLD_DAYS = 3;
    const checkedFormats = ["Standard", "Modern", "Pioneer", "Legacy", "Vintage"];
    const stale = [];
    for (const format of checkedFormats) {
      const latest = latestByFormat.get(format);
      const daysStale = latest
        ? Math.floor((Date.now() - new Date(`${latest}T00:00:00Z`).getTime()) / 86400000)
        : Infinity;
      if (daysStale > STALE_THRESHOLD_DAYS) stale.push(`${format}(最新${latest ?? "無し"})`);
    }
    if (stale.length > 0) return `${stale.join(", ")}が${STALE_THRESHOLD_DAYS}日以上更新無し`;
    return null;
  });

  await check("デッキのアーキタイプ分類率（直近7日）", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const rows = await supabaseGet(
      `decks?select=archetype_id,tournaments!inner(event_date)&tournaments.event_date=gte.${sevenDaysAgo}`,
    );
    if (rows.length === 0) return null; // 直近7日にデッキが無いのは別問題（ここでは扱わない）
    const classified = rows.filter((r) => r.archetype_id !== null).length;
    const rate = classified / rows.length;
    if (rate < 0.5) return `${(rate * 100).toFixed(1)}%（${classified}/${rows.length}件）。classify-decks系ステップが止まっている可能性`;
    return null;
  });

  if (warnings.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## データヘルスチェック警告\n\n${warnings.join("\n")}\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
