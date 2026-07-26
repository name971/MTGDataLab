/**
 * 既存のcard_oracles全件にoracle_text（ルールテキスト）を後付けで埋める一括バックフィル。
 * rebuild-representative-prints.mjs（1oracleずつGET+DELETE+POST）で全件やり直すと非常に遅いため、
 * バルクデータを1回ストリーミングして各oracle_idの代表候補を選びつつ、
 * printed_name_ja等の既存値はそのままにoracle_textだけバッチで追記する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-oracle-text.mjs
 */

import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  isBetterRepresentative,
  combinedOracleText,
} from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

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
  const deduped = [...new Map(rows.map((r) => [r.oracle_id, r])).values()];
  for (let i = 0; i < deduped.length; i += PAGE_SIZE) {
    const chunk = deduped.slice(i, i + PAGE_SIZE);
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
  return deduped.length;
}

async function main() {
  await ensureBulkData();

  const oracles = await supabaseGet("card_oracles?select=oracle_id,name,printed_name_ja,oracle_text&order=oracle_id.asc");
  const missing = oracles.filter((o) => !o.oracle_text);
  const missingIds = new Set(missing.map((o) => o.oracle_id));
  console.log(`card_oracles: ${oracles.length}件中 oracle_text欠落: ${missing.length}件`);

  const bestEnByOracle = new Map();
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || raw.digital || !raw.oracle_id) return;
    if (!missingIds.has(raw.oracle_id)) return;
    const current = bestEnByOracle.get(raw.oracle_id);
    if (isBetterRepresentative(raw, current)) bestEnByOracle.set(raw.oracle_id, raw);
  });
  console.log(`バルクデータから解決: ${bestEnByOracle.size}/${missing.length}件`);

  const updateRows = missing
    .filter((o) => bestEnByOracle.has(o.oracle_id))
    .map((o) => ({
      oracle_id: o.oracle_id,
      name: o.name,
      printed_name_ja: o.printed_name_ja,
      oracle_text: combinedOracleText(bestEnByOracle.get(o.oracle_id)),
    }));

  const saved = await supabaseUpsert("card_oracles", updateRows, "oracle_id");
  console.log(`\n完了: card_oracles ${saved}件のoracle_textを更新`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
