/**
 * SAMPLE_CARD_SLUGS（src/lib/sampleCards.ts）に載っているカードをScryfallのバルクデータから取得し、
 * card_oracles / cards（db/schema.sql）に投入する一回限りのインポートスクリプト。
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/import-sample-cards.mjs
 *
 * 代表プリント（cards選定ルール、db/schema.sql 1章）と日本語版プリント（存在する場合）のみ投入する。
 * 全プリントは投入しない（データ肥大化対策、db/schema.sql 8章と同じ方針）。
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
  findJapanesePrint,
  findAnyJapaneseName,
  frontFaceName,
  frontFacePrintedName,
  toCardRow,
} from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const SAMPLE_CARD_NAMES = [
  "Ragavan, Nimble Pilferer",
  "Solitude",
  "Persist",
  "Wrenn and Six",
  "Orcish Bowmasters",
  "Up the Beanstalk",
  "Sunfall",
  "Sheoldred, the Apocalypse",
  "Fable of the Mirror-Breaker",
  "This Town Ain't Big Enough",
  "Force of Will",
  "Restoration Angel",
  "Kroxa, Titan of Death's Hunger",
  "Wasteland",
  "Daze",
  "Mishra's Bauble",
  "Chalice of the Void",
  "Mystic Remora",
  "Grim Monolith",
  "Sol Ring",
  "Arcane Signet",
  "Cyclonic Rift",
];

async function supabaseUpsert(table, rows, conflictColumn) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${table} upsert failed: ${res.status} ${text}`);
  }
}

async function main() {
  await ensureBulkData();
  const index = await loadIndex();

  let imported = 0;
  let skipped = 0;

  for (const name of SAMPLE_CARD_NAMES) {
    const enCard = findEnglishCard(index, name);
    if (!enCard) {
      console.error(`✗ ${name}: バルクデータで見つからず`);
      skipped++;
      continue;
    }

    const jaCard = findJapanesePrint(index, enCard.oracle_id, enCard.set, enCard.collector_number);
    const printedNameJa = jaCard ? frontFacePrintedName(jaCard) : findAnyJapaneseName(index, enCard.oracle_id);

    await supabaseUpsert(
      "card_oracles",
      [
        {
          oracle_id: enCard.oracle_id,
          name: frontFaceName(enCard),
          printed_name_ja: printedNameJa,
        },
      ],
      "oracle_id",
    );

    const cardRows = [toCardRow(enCard, enCard.oracle_id)];
    if (jaCard) cardRows.push(toCardRow(jaCard, enCard.oracle_id));
    await supabaseUpsert("cards", cardRows, "scryfall_id");

    console.log(`✓ ${frontFaceName(enCard)}${jaCard ? ` / ${frontFacePrintedName(jaCard)}` : ""}`);
    imported++;
  }

  console.log(`\n完了: ${imported}件インポート、${skipped}件スキップ`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
