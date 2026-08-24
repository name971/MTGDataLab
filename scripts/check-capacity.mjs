/**
 * Supabase DB容量とR2書き込み枠（当月分）をまとめて確認する。大量書き込み前に毎回
 * 別々のクエリを打っていたため使い回せる形にした（2026-08-25）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *      node scripts/check-capacity.mjs
 * （CLOUDFLARE_API_TOKENにはアカウント分析（Account Analytics）の読み取り権限が必要）
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

async function checkSupabaseDbSize() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log("Supabase DB容量: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY未設定のためスキップ");
    return;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_database_size_bytes`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    console.log(`Supabase DB容量: 取得失敗 (${res.status})`);
    return;
  }
  const bytes = await res.json();
  const mb = bytes / 1024 / 1024;
  console.log(`Supabase DB容量: ${mb.toFixed(1)} MB / 500 MB（無料枠）`);
}

async function checkR2Operations() {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
    console.log("R2書き込み枠: CLOUDFLARE_API_TOKEN/ACCOUNT_ID未設定のためスキップ");
    return;
  }
  const start = new Date();
  start.setUTCDate(1);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = new Date().toISOString().slice(0, 10);

  const query = `
    query($accountTag: string!, $start: Date!, $end: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          r2OperationsAdaptiveGroups(limit: 100, filter: {date_geq: $start, date_leq: $end}) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }
  `;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: CLOUDFLARE_ACCOUNT_ID, start: startStr, end: endStr } }),
  });
  const json = await res.json();
  const groups = json?.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups;
  if (!groups) {
    console.log("R2書き込み枠: 取得失敗", JSON.stringify(json.errors ?? json));
    return;
  }
  const put = groups.find((g) => g.dimensions.actionType === "PutObject")?.sum.requests ?? 0;
  const get = groups.find((g) => g.dimensions.actionType === "GetObject")?.sum.requests ?? 0;
  console.log(`R2 PutObject（今月、無料枠100万/月）: ${put.toLocaleString()}件${put > 1_000_000 ? "  [超過]" : ""}`);
  console.log(`R2 GetObject（今月、無料枠1000万/月）: ${get.toLocaleString()}件${get > 10_000_000 ? "  [超過]" : ""}`);
}

async function main() {
  await checkSupabaseDbSize();
  await checkR2Operations();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
