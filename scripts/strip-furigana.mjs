/**
 * card_oracles.printed_name_ja / cards.printed_name_ja に混入しているふりがな
 * （全角括弧、例: "神（かみ）無（な）き祭（さい）殿（でん）"）を取り除く一回限りの
 * クリーンアップスクリプト。今後のインポートはscripts/lib/scryfallBulk.mjsの
 * frontFacePrintedNameで既に除去されるので、ここでは既存データだけを直す。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/strip-furigana.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const h = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
const PAGE_SIZE = 1000;

function stripFurigana(name) {
  if (!name) return name;
  // まれに閉じ括弧が無いまま途切れている壊れたデータがある（例: "軍旗手（しゅ"）ため、
  // 通常の閉じ括弧ありパターンに加えて、文字列末尾の閉じられていない開き括弧以降も切り捨てる。
  return name.replace(/（[^（）]*）/g, "").replace(/（[^（）]*$/, "").trim();
}

async function getAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...h, Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function patch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

async function cleanTable(table, idColumn) {
  const rows = await getAll(`${table}?printed_name_ja=not.is.null&select=${idColumn},printed_name_ja`);
  console.log(`${table}: ${rows.length}件中ふりがな混入を確認...`);
  let fixed = 0;
  for (const row of rows) {
    const cleaned = stripFurigana(row.printed_name_ja);
    if (cleaned !== row.printed_name_ja) {
      await patch(`${table}?${idColumn}=eq.${row[idColumn]}`, { printed_name_ja: cleaned });
      fixed++;
      if (fixed % 100 === 0) console.log(`  ...${fixed}件修正済み`);
    }
  }
  console.log(`${table}: 完了、${fixed}件修正`);
}

async function main() {
  await cleanTable("card_oracles", "oracle_id");
  await cleanTable("cards", "scryfall_id");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
