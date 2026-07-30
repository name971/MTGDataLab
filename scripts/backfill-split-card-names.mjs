/**
 * scripts/lib/scryfallBulk.mjsのfrontFaceName/frontFacePrintedNameの修正
 * （split/aftermath layoutはcard_faces[0]ではなくトップレベルの結合済みname"X // Y"を
 * 使うべきだった、というバグ修正）を、既存のcard_oracles/cardsに反映する。
 * rebuild-representative-prints.mjsは全oracle（3万件超）を1件ずつDB往復するため
 * 実行に1〜2時間かかる想定だが、影響を受けるのはsplit/aftermath layoutの302プリント
 * （ユニークオラクルはもっと少ない）だけなので、対象を絞って高速に処理する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/backfill-split-card-names.mjs
 */

import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  frontFaceName,
  frontFacePrintedName,
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

async function supabasePatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  await ensureBulkData();

  // 英語版のsplit/aftermathカードをoracle_idごとに1件ずつ集める（複数プリントあっても代表1件でよい）
  const bestEnByOracle = new Map();
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || raw.digital) return;
    if (raw.layout !== "split" && raw.layout !== "aftermath") return;
    if (!bestEnByOracle.has(raw.oracle_id)) bestEnByOracle.set(raw.oracle_id, raw);
  });
  console.log(`対象オラクル（split/aftermath、英語）: ${bestEnByOracle.size}件`);

  const oracleIds = [...bestEnByOracle.keys()];
  const existingOracles = await supabaseGet(
    `card_oracles?oracle_id=in.(${oracleIds.join(",")})&select=oracle_id,name,printed_name_ja`,
  );
  const existingByOracleId = new Map(existingOracles.map((o) => [o.oracle_id, o]));
  console.log(`既存card_oracles該当: ${existingOracles.length}件`);

  let fixedOracles = 0;
  for (const [oracleId, raw] of bestEnByOracle) {
    const existing = existingByOracleId.get(oracleId);
    if (!existing) continue; // このプロジェクトに未登録のカードはスキップ

    const correctName = frontFaceName(raw);
    if (existing.name === correctName) continue; // 既に正しい

    await supabasePatch(`card_oracles?oracle_id=eq.${oracleId}`, {
      name: correctName,
      oracle_text: combinedOracleText(raw),
    });
    console.log(`  ✓ ${existing.name} -> ${correctName}`);
    fixedOracles++;
  }
  console.log(`\ncard_oracles.name修正: ${fixedOracles}件`);

  // cards（代表プリント）側のnameも同様に直す。printed_name_jaはJA版プリントが別途あれば
  // frontFacePrintedNameで直すが、split/aftermathでJA版が存在するカードは稀なので
  // 英語版cards行のnameだけまず直し、JA版はfindJapanesePrint経由の既存ロジックに任せる。
  const { data: enCardsData } = { data: null };
  void enCardsData;
  const enCards = await supabaseGet(
    `cards?oracle_id=in.(${oracleIds.join(",")})&lang=eq.en&select=scryfall_id,oracle_id,name`,
  );
  let fixedCards = 0;
  for (const card of enCards) {
    const raw = bestEnByOracle.get(card.oracle_id);
    if (!raw) continue;
    const correctName = frontFaceName(raw);
    if (card.name === correctName) continue;
    await supabasePatch(`cards?scryfall_id=eq.${card.scryfall_id}`, { name: correctName });
    fixedCards++;
  }
  console.log(`cards.name修正: ${fixedCards}件`);

  console.log("\n完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
