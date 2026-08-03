/**
 * 一時修正スクリプト: scripts/lib/scryfallBulk.mjsのstripFuriganaがルールテキスト（printed_text_ja）
 * にも誤って適用されており、リマインダーテキスト（例:「（ターン終了時まで、～）」）が消えていた
 * バグの後始末。stripFurigana除去後のcombinedPrintedTextで、lang='ja'の全行を対象に
 * printed_text_jaを再構築して上書きする（NULLの行だけを埋めるbackfill-printed-text.mjsと違い、
 * 既に何か値が入っている行も含めて全件対象にする）。1回限りの実行で用済みになったら削除してよい。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/fix-printed-text-reminder.mjs
 */

import { ensureBulkData, forEachJsonArrayObject, DATA_FILE, toCardRow } from "./lib/scryfallBulk.mjs";

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

async function main() {
  await ensureBulkData();

  const jaCards = await supabaseGet("cards?select=scryfall_id,oracle_id&lang=eq.ja&order=scryfall_id.asc");
  const oracleByScryfallId = new Map(jaCards.map((c) => [c.scryfall_id, c.oracle_id]));
  console.log(`対象ja cards: ${jaCards.length}件`);

  const updateRows = [];
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "ja" || !oracleByScryfallId.has(raw.id)) return;
    updateRows.push(toCardRow(raw, oracleByScryfallId.get(raw.id)));
  });
  console.log(`解決: ${updateRows.length}件`);

  await supabaseUpsert("cards", updateRows, "scryfall_id");
  console.log("完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
