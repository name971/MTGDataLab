/**
 * cardsテーブルの英語版type_line・日本語版printed_type_lineのペアから、クリーチャー・タイプ等の
 * 日本語↔英語対応表を自動生成し、src/lib/typeGlossary.tsに書き出す。
 *
 * 背景: 高度検索（src/lib/dbAdvancedSearch.ts）のタイプ行検索は、日本語版プリントが存在する
 * オラクルしか日本語クエリでヒットしない（例:「マーフォーク」で検索しても日本語版が無いカードは
 * type_line自体が英語のままなので引っかからない）。手作業でクリーチャータイプ辞書を作る代わりに、
 * 既にインポート済みの日英両プリントを持つカードから対応関係を統計的に推定する。
 *
 * 手法: 同一oracle_idの英語type_line（"Creature — Merfolk Wizard"）と日本語printed_type_line
 * （"クリーチャー — マーフォーク・ウィザード"）を、それぞれ" — "で分割してサブタイプ部分だけ取り出し、
 * さらに英語は空白、日本語は「・」で分割する。トークン数が一致するペアだけ、同じ位置同士を
 * 対応づける（複数サブタイプの並び順は英日で一致する前提）。最終的に各日本語トークンについて
 * 最頻出の英語訳を採用する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/generate-type-glossary.mjs
 */

import { writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

async function supabaseGetAll(path) {
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

// 最小出現回数未満のペアはタイプミス・誤爆の可能性があるため辞書に含めない
const MIN_OCCURRENCES = 3;

async function main() {
  console.log("英語版type_lineを取得中...");
  const enRows = await supabaseGetAll("cards?lang=eq.en&select=oracle_id,type_line");
  console.log(`${enRows.length}件`);

  console.log("日本語版printed_type_lineを取得中...");
  const jaRows = await supabaseGetAll(
    "cards?lang=eq.ja&printed_type_line=not.is.null&select=oracle_id,printed_type_line",
  );
  console.log(`${jaRows.length}件`);

  const enByOracle = new Map(enRows.map((r) => [r.oracle_id, r.type_line]));

  // ja token -> en token -> 出現回数
  const counts = new Map();
  let paired = 0;
  let skipped = 0;
  for (const r of jaRows) {
    const en = enByOracle.get(r.oracle_id);
    if (!en || !r.printed_type_line) continue;
    const [, enSub] = en.split(" — ");
    const [, jaSub] = r.printed_type_line.split(" — ");
    if (!enSub || !jaSub) continue;
    const enTokens = enSub.split(" ").filter(Boolean);
    const jaTokens = jaSub.split("・").filter(Boolean);
    if (enTokens.length !== jaTokens.length) {
      skipped++;
      continue;
    }
    paired++;
    for (let i = 0; i < enTokens.length; i++) {
      const jaToken = jaTokens[i];
      const enToken = enTokens[i];
      if (!counts.has(jaToken)) counts.set(jaToken, new Map());
      const byEn = counts.get(jaToken);
      byEn.set(enToken, (byEn.get(enToken) ?? 0) + 1);
    }
  }
  console.log(`対応付け成功: ${paired}件、トークン数不一致でスキップ: ${skipped}件`);

  const glossary = {};
  for (const [jaToken, byEn] of counts) {
    const [bestEn, bestCount] = [...byEn.entries()].sort((a, b) => b[1] - a[1])[0];
    if (bestCount >= MIN_OCCURRENCES) glossary[jaToken] = bestEn;
  }
  const sortedGlossary = Object.fromEntries(Object.entries(glossary).sort(([a], [b]) => a.localeCompare(b, "ja")));
  console.log(`辞書エントリ数: ${Object.keys(sortedGlossary).length}`);

  const fileContent = `/**
 * タイプ行のクリーチャー・タイプ等、日本語→英語の対応表。
 * scripts/generate-type-glossary.mjsが、cardsテーブルの英日ペア（同一オラクルの
 * type_line・printed_type_line）から統計的に生成する（手作業のメンテナンス不要）。
 * 高度検索（src/lib/dbAdvancedSearch.ts）で、日本語版プリントを持たないカードも
 * 日本語のタイプ名で検索できるようにするために使う。
 *
 * 再生成: node scripts/generate-type-glossary.mjs
 */
export const TYPE_GLOSSARY_JA_TO_EN: Record<string, string> = ${JSON.stringify(sortedGlossary, null, 2)};
`;
  writeFileSync(new URL("../src/lib/typeGlossary.ts", import.meta.url), fileContent);
  console.log("\n完了: src/lib/typeGlossary.ts を書き出しました");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
