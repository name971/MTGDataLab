/**
 * sets.icon_svg_uri（db/schema.sql）を、Scryfallの/setsエンドポイント（全セット一括・
 * 1リクエストで完結、ページングされない）から埋める。
 *
 * カードのバルクデータ（scripts/import-full-catalog.mjs）には各セットのアイコンURLが
 * 含まれておらず、`https://svgs.scryfall.io/sets/<set_code>.svg`という命名規則も一部の
 * 特殊セット（Secret Lair Drop等）では成り立たない（例: sld → star.svg）ため、正しい
 * アイコンURLを持つ/setsエンドポイントから別途同期する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-set-icons.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

async function supabaseUpsert(table, rows, conflictColumn) {
  const PAGE_SIZE = 1000;
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
  console.log("Scryfall /sets を取得中...");
  const res = await fetch("https://api.scryfall.com/sets", {
    headers: { "User-Agent": "jp-mtgstocks/0.1 (+https://github.com/jp-mtgstocks)", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Scryfall /sets failed: ${res.status}`);
  const body = await res.json();
  // PostgRESTのon_conflict upsertはON CONFLICT DO UPDATEでも、INSERT句自体にNOT NULL列
  // （set_name）が無いと制約違反になるため、set_nameも一緒に送る（既存の値を同じ値で
  // 上書きするだけなので実害はない）
  const rows = body.data
    .filter((s) => s.icon_svg_uri)
    .map((s) => ({ set_code: s.code, set_name: s.name, icon_svg_uri: s.icon_svg_uri }));
  console.log(`${rows.length}件のセットアイコンURLを反映中...`);

  await supabaseUpsert("sets", rows, "set_code");
  console.log("完了。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
