/**
 * Supabase無料枠（500MB）に対するDB容量を日次でチェックし、閾値を超えたら警告する。
 * pg_database_size()はPostgRESTのテーブルAPIでは呼べないため、get_database_size_bytes()
 * というSQL関数（db/schema.sql参照）をRPC経由で呼び出す。
 * VACUUM自体はPostgRESTから実行できない（トランザクション内で使えないコマンドのため）ので
 * ここでは自動修復はせず、閾値超過をログとGitHub Actionsのジョブサマリーに出すだけに留める。
 * 実際の対応（VACUUM FULL等）は手動で行う想定。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/check-db-size.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// Supabase無料枠の実容量（500MB）に対し、余裕を持って警告を出す閾値
const WARN_THRESHOLD_BYTES = 450 * 1024 * 1024;

async function main() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_database_size_bytes`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`get_database_size_bytes failed: ${res.status} ${await res.text()}`);
  const bytes = await res.json();
  const mb = bytes / 1024 / 1024;

  console.log(`DB容量: ${mb.toFixed(1)} MB / 500 MB（無料枠）`);

  if (bytes >= WARN_THRESHOLD_BYTES) {
    const message = `⚠️ DB容量が${(WARN_THRESHOLD_BYTES / 1024 / 1024).toFixed(0)}MBの警告ラインを超えています（現在${mb.toFixed(1)}MB）。VACUUM FULL等の対応を検討してください。`;
    console.warn(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = await import("node:fs/promises");
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
