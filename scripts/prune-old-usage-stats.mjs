/**
 * card_usage_stats（266,047行、db容量超過の主要因の一つ）は、これまで一度も削除されず
 * 積み上がるだけの日次スナップショットだった。実際に読んでいるのは:
 *   - dbCardRanking.ts / dbTrendingRanking.ts: 最新1日分のみ
 *   - compute-card-streaks.mjs: 直近STREAK_LOOKBACK_DAYS（60日）分
 * なので、それより古い行は本当に不要。streak計算が必要とするちょうど60日
 * （マージン無し）をRETENTION_DAYSとし、それより古い行を削除する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/prune-old-usage-stats.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const RETENTION_DAYS = 60;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = isoDate(cutoff);

  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/card_usage_stats?select=id&calculated_at=lt.${cutoffStr}`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    },
  );
  const totalToDelete = Number(countRes.headers.get("content-range")?.split("/")[1] ?? 0);
  console.log(`削除対象（${cutoffStr}より前）: ${totalToDelete}件`);

  if (totalToDelete === 0) {
    console.log("削除対象なし");
    return;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/card_usage_stats?calculated_at=lt.${cutoffStr}`, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "count=exact",
    },
  });
  if (!res.ok) throw new Error(`DELETE failed: ${res.status} ${await res.text()}`);
  console.log(`削除完了: ${totalToDelete}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
