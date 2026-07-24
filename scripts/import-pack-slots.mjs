/**
 * src/lib/samplePackData.ts の PLAY_BOOSTER_SLOTS / SAMPLE_SETS を
 * pack_slot_definitions / sealed_price_snapshots（db/schema.sql）に投入する。
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/import-pack-slots.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

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
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
}

// samplePackData.tsはTypeScriptなので、この素のNodeスクリプトからは直接importできない。
// 値をそのまま複製する（差分が出たらこのファイルとsamplePackData.tsを両方直すこと）。
const PLAY_BOOSTER_SLOTS = [
  { slotName: "確定コモン", cardCount: 7, probabilityByRarity: { common: 1 } },
  { slotName: "確定アンコモン", cardCount: 3, probabilityByRarity: { uncommon: 1 } },
  { slotName: "レア/神話スロット", cardCount: 1, probabilityByRarity: { rare: 0.8571, mythic: 0.1429 } },
  {
    slotName: "ワイルドカード（非フォイル）",
    cardCount: 1,
    probabilityByRarity: { common: 0.7, uncommon: 0.175, rare: 0.1071, mythic: 0.0179 },
  },
  {
    slotName: "ワイルドカード（フォイル）",
    cardCount: 1,
    probabilityByRarity: { common: 0.6, uncommon: 0.25, rare: 0.1286, mythic: 0.0214 },
  },
];

const SETS_WITH_SLOTS = {
  blb: PLAY_BOOSTER_SLOTS,
  dsk: PLAY_BOOSTER_SLOTS,
  dft: [
    { slotName: "確定コモン", cardCount: 7, probabilityByRarity: { common: 1 } },
    { slotName: "確定アンコモン", cardCount: 3, probabilityByRarity: { uncommon: 1 } },
    { slotName: "レア/神話スロット", cardCount: 1, probabilityByRarity: { rare: 0.8571, mythic: 0.1429 } },
    { slotName: "ワイルドカード（非フォイル）", cardCount: 1, probabilityByRarity: { common: 0.125, uncommon: 0.667, rare: 0.1783, mythic: 0.0297 } },
    { slotName: "ワイルドカード（フォイル）", cardCount: 1, probabilityByRarity: { common: 0.61, uncommon: 0.305, rare: 0.0729, mythic: 0.0121 } },
  ],
  tdm: [
    { slotName: "確定コモン", cardCount: 7, probabilityByRarity: { common: 1 } },
    { slotName: "確定アンコモン", cardCount: 3, probabilityByRarity: { uncommon: 1 } },
    { slotName: "レア/神話スロット", cardCount: 1, probabilityByRarity: { rare: 0.8537, mythic: 0.1463 } },
    { slotName: "ワイルドカード（非フォイル）", cardCount: 1, probabilityByRarity: { common: 0.1594, uncommon: 0.6117, rare: 0.1949, mythic: 0.034 } },
    { slotName: "ワイルドカード（フォイル）", cardCount: 1, probabilityByRarity: { common: 0.5775, uncommon: 0.3304, rare: 0.0784, mythic: 0.0136 } },
  ],
  eoe: [
    { slotName: "確定コモン", cardCount: 7, probabilityByRarity: { common: 1 } },
    { slotName: "確定アンコモン", cardCount: 3, probabilityByRarity: { uncommon: 1 } },
    { slotName: "レア/神話スロット", cardCount: 1, probabilityByRarity: { rare: 0.8439, mythic: 0.1561 } },
    { slotName: "ワイルドカード（非フォイル）", cardCount: 1, probabilityByRarity: { common: 0.143, uncommon: 0.714, rare: 0.135, mythic: 0.008 } },
    { slotName: "ワイルドカード（フォイル）", cardCount: 1, probabilityByRarity: { common: 0.5875, uncommon: 0.3241, rare: 0.075, mythic: 0.0137 } },
  ],
};

async function main() {
  const rows = [];
  for (const [setCode, slots] of Object.entries(SETS_WITH_SLOTS)) {
    for (const slot of slots) {
      for (const [rarity, probability] of Object.entries(slot.probabilityByRarity)) {
        rows.push({
          set_code: setCode,
          product_type: "play_booster",
          slot_name: slot.slotName,
          rarity,
          probability,
          card_count: slot.cardCount,
        });
      }
    }
  }

  await supabaseUpsert("pack_slot_definitions", rows, "set_code,product_type,slot_name,rarity");
  console.log(`pack_slot_definitions: ${rows.length}行投入（${Object.keys(SETS_WITH_SLOTS).length}セット分）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
