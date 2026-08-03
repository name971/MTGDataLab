/**
 * card_oracles全件について、新しい選定基準（英語版は最安値のトーナメント対応プリント、
 * 日本語版はその英語版と同じセットのものだけ・無ければ無し）で代表プリントを選び直し、
 * cardsテーブルを丸ごと作り直す。
 *
 * scripts/lib/scryfallBulk.mjsのisBetterRepresentative（最安値優先に変更）・
 * findJapanesePrint（同一セット限定に変更）を適用するための一括再構築スクリプト。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/rebuild-representative-prints.mjs
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

  const oracles = await supabaseGet("card_oracles?select=oracle_id,name,printed_name_ja,oracle_text&order=oracle_id.asc");
  console.log(`card_oracles: ${oracles.length}件を再構築`);

  let updated = 0;
  let unchanged = 0;
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

    // 既存のcards行（この oracle_id の en/ja 各1行のはず）を取得し、
    // 選び直した結果と違うscryfall_idのものだけ差し替える
    const existingRows = await supabaseGet(
      `cards?select=scryfall_id,lang&oracle_id=eq.${oracle.oracle_id}`,
    );
    const existingEn = existingRows.find((r) => r.lang === "en");
    const existingJa = existingRows.find((r) => r.lang === "ja");

    const enChanged = !existingEn || existingEn.scryfall_id !== better.id;
    const jaChanged = jaCard
      ? !existingJa || existingJa.scryfall_id !== jaCard.id
      : !!existingJa; // 新基準では日本語版なし判定なのに、古い行が残っている場合も差し替え対象

    // 画像用のcards行は変わらなくても、名前だけの日本語フォールバックが変わることがあるので別途判定する
    const newPrintedNameJa = jaCard ? frontFacePrintedName(jaCard) : findAnyJapaneseName(index, better.oracle_id);
    const nameJaChanged = newPrintedNameJa !== oracle.printed_name_ja;
    const newOracleText = combinedOracleText(better);
    const oracleTextChanged = newOracleText !== oracle.oracle_text;

    if (!enChanged && !jaChanged && !nameJaChanged && !oracleTextChanged) {
      unchanged++;
      continue;
    }

    // 差し替え対象の古い行を削除する
    for (const row of existingRows) {
      const isStaleEn = row.lang === "en" && enChanged;
      const isStaleJa = row.lang === "ja" && jaChanged;
      if (!isStaleEn && !isStaleJa) continue;
      await supabaseDelete(`cards?scryfall_id=eq.${row.scryfall_id}`);
    }

    const newRows = [toCardRow(better, oracle.oracle_id)];
    if (jaCard) newRows.push(toCardRow(jaCard, oracle.oracle_id));
    await supabaseUpsert("cards", newRows, "scryfall_id");

    oracleUpdates.push({
      oracle_id: oracle.oracle_id,
      name: frontFaceName(better),
      // 画像に使うjaCard（同一プリント限定）が無くても、名前だけは他プリントの日本語版から拾う。
      printed_name_ja: newPrintedNameJa,
      oracle_text: newOracleText,
    });

    updated++;
    if (updated % 100 === 0) console.log(`  ...${updated}件更新済み`);
  }

  await supabaseUpsert("card_oracles", oracleUpdates, "oracle_id");

  console.log(`\n完了: ${updated}件更新、${unchanged}件変更なし、${notFound}件バルクデータで見つからず`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
