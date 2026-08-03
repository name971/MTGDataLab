/**
 * cardsテーブルは本来oracle_idごとに代表プリント（lang='en'）1行・日本語版（lang='ja'）最大1行の
 * はずだが、実データには同じoracle_id+langの行が複数残っているケースが約7,400件（全オラクルの
 * 約1/3）見つかった。
 *
 * 原因: scripts/rebuild-representative-prints.mjsは「選び直した代表プリントが既存行の中に
 * 既に含まれていれば"変更なし"とみなしてスキップする」ロジックのため、たまたま正しいプリントが
 * 重複行の中に混ざっていると、他の古い重複行が永久にクリーンアップされずに残る。
 *
 * このスクリプトは重複が残っているoracle_idだけを対象に、正しい代表プリント（英語は最安値の
 * トーナメント対応プリント、日本語はその英語版と同じセットのものだけ）を選び直し、
 * それ以外の重複行を削除する（rebuild-representative-prints.mjsと同じ選定ロジックを流用）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/dedupe-representative-prints.mjs [limit]
 * limitを指定すると、重複があるオラクルのうち先頭limit件だけ処理する（動作確認用）。
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
  findJapanesePrint,
  findAnyJapaneseCard,
  findAnyJapaneseName,
  frontFaceName,
  frontFacePrintedName,
  combinedOracleText,
  toCardRow,
} from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;
const ID_CHUNK = 150; // .in()にUUIDを大量に並べるとURLが長すぎてPostgRESTが400を返すため

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
  if (rows.length === 0) return;
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
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  await ensureBulkData();
  const index = await loadIndex();

  console.log("cards全件を取得中...");
  const allCards = await supabaseGet("cards?select=scryfall_id,oracle_id,lang&order=oracle_id.asc");
  console.log(`${allCards.length}行`);

  const rowsByOracle = new Map(); // oracle_id -> { en: [scryfall_id,...], ja: [scryfall_id,...] }
  for (const c of allCards) {
    if (!rowsByOracle.has(c.oracle_id)) rowsByOracle.set(c.oracle_id, { en: [], ja: [] });
    rowsByOracle.get(c.oracle_id)[c.lang]?.push(c.scryfall_id);
  }

  let dupeOracleIds = [...rowsByOracle.entries()]
    .filter(([, g]) => g.en.length > 1 || g.ja.length > 1)
    .map(([oracleId]) => oracleId);
  console.log(`重複あり: ${dupeOracleIds.length}件のオラクル`);
  if (dupeOracleIds.length === 0) return;

  const limit = Number(process.argv[2]);
  if (Number.isFinite(limit) && limit > 0) {
    dupeOracleIds = dupeOracleIds.slice(0, limit);
    console.log(`--limitにより先頭${dupeOracleIds.length}件のみ処理`);
  }

  const oracles = [];
  for (let i = 0; i < dupeOracleIds.length; i += ID_CHUNK) {
    const chunk = dupeOracleIds.slice(i, i + ID_CHUNK);
    const page = await supabaseGet(
      `card_oracles?select=oracle_id,name,printed_name_ja,oracle_text&oracle_id=in.(${chunk.join(",")})`,
    );
    oracles.push(...page);
  }
  console.log(`card_oracles: ${oracles.length}件取得`);

  let cleaned = 0;
  let notFound = 0;
  const oracleUpdates = [];

  for (const oracle of oracles) {
    const better = findEnglishCard(index, oracle.name);
    if (!better) {
      notFound++;
      continue;
    }
    // 代表プリントと同じ版の日本語版が無い場合、他の版の日本語版でも良いのでルールテキスト・
    // タイプ行だけは翻訳を出す（backfill-missing-ja-cards.mjsと同じ方針。画像はズレる可能性が
    // あるが、名前・テキストが英語のまま残るよりまし）。
    const jaCard =
      findJapanesePrint(index, better.oracle_id, better.set, better.collector_number) ??
      findAnyJapaneseCard(index, better.oracle_id);

    const group = rowsByOracle.get(oracle.oracle_id);
    const keepEnId = better.id;
    const keepJaId = jaCard?.id ?? null;

    const staleEnIds = group.en.filter((id) => id !== keepEnId);
    const staleJaIds = group.ja.filter((id) => id !== keepJaId);
    if (staleEnIds.length === 0 && staleJaIds.length === 0) continue;

    for (const scryfallId of [...staleEnIds, ...staleJaIds]) {
      await supabaseDelete(`cards?scryfall_id=eq.${scryfallId}`);
    }

    // 正しい代表プリントが既存行に無かった場合（重複が全部ハズレだった場合）は新規投入する
    const newRows = [];
    if (!group.en.includes(keepEnId)) newRows.push(toCardRow(better, oracle.oracle_id));
    if (keepJaId && !group.ja.includes(keepJaId)) newRows.push(toCardRow(jaCard, oracle.oracle_id));
    if (newRows.length > 0) await supabaseUpsert("cards", newRows, "scryfall_id");

    const newPrintedNameJa = jaCard ? frontFacePrintedName(jaCard) : findAnyJapaneseName(index, better.oracle_id);
    const newOracleText = combinedOracleText(better);
    if (newPrintedNameJa !== oracle.printed_name_ja || newOracleText !== oracle.oracle_text) {
      oracleUpdates.push({
        oracle_id: oracle.oracle_id,
        name: frontFaceName(better),
        printed_name_ja: newPrintedNameJa,
        oracle_text: newOracleText,
      });
    }

    cleaned++;
    if (cleaned % 200 === 0) console.log(`  ...${cleaned}件クリーンアップ済み`);
  }

  if (oracleUpdates.length > 0) await supabaseUpsert("card_oracles", oracleUpdates, "oracle_id");

  console.log(`\n完了: ${cleaned}件クリーンアップ、${notFound}件バルクデータで見つからず`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
