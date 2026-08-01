/**
 * pack_slot_definitions（既に登録済みのセット一覧、db/schema.sql）にある各セット×商品種別について、
 * MTGJSON（https://mtgjson.com/api/v5/{SET}.json）のbooster.play/collector.sheetsから
 * ブースターシートのカード構成（カードごとの出現ウェイト）を取得し、pack_slot_cards
 * （db/schema.sql）に1枚1行で投入する。
 *
 * scripts/generate-pack-data.mjsのanalyzeSheet/classifySheetロジックを流用しているが、
 * あちらは価格まで一度に計算して静的ファイルに書き出すのに対し、こちらは
 * 「カード構成（scryfall_id・ウェイト・foilフラグ）」だけを保存する。価格は日次で変わるため
 * scripts/compute-pack-slot-avg-prices.mjsが毎日別に計算する（構成は基本的に変わらないので
 * このスクリプトは新セット追加時のみ再実行すればよい）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/import-pack-slot-cards.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; jp-mtgstocks/0.1)" };
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

let setListCache = null;
async function fetchSetList() {
  if (setListCache) return setListCache;
  const res = await fetch("https://mtgjson.com/api/v5/SetList.json", { headers: FETCH_HEADERS });
  const data = await res.json();
  setListCache = data.data;
  return setListCache;
}

// scripts/generate-pack-data.mjsと同じ例外リスト（名前一致で検出できない便乗特典セット）
const KNOWN_UNNAMED_COMPANIONS = {
  otj: ["BIG", "OTP", "SPG"],
  msh: ["MAR"],
  spm: ["MAR"],
  lci: ["REX"],
};

async function fetchCompanionSetCodes(setCode, setName) {
  const setList = await fetchSetList();
  const byName = setList
    .filter((s) => s.code.toUpperCase() !== setCode.toUpperCase() && s.name.includes(setName))
    .map((s) => s.code);
  const known = KNOWN_UNNAMED_COMPANIONS[setCode.toLowerCase()] ?? [];
  return [...new Set([...byName, ...known])];
}

async function buildCardPool(setCode, companionCodes) {
  const cardByUuid = new Map();
  for (const code of [setCode, ...companionCodes]) {
    const res = await fetch(`https://mtgjson.com/api/v5/${code.toUpperCase()}.json`, { headers: FETCH_HEADERS });
    if (!res.ok) continue;
    const json = await res.json();
    for (const card of json.data.cards) cardByUuid.set(card.uuid, card);
  }
  return cardByUuid;
}

function analyzeSheet(cardByUuid, sheets, sheetName) {
  const sheet = sheets?.[sheetName];
  if (!sheet) return null;
  const totalWeight = Object.values(sheet.cards).reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return null;

  const rarityFractionRaw = {};
  let landWeight = 0;
  let matchedWeight = 0;
  const foil = !!sheet.foil;
  const cards = [];
  for (const [uuid, weight] of Object.entries(sheet.cards)) {
    const card = cardByUuid.get(uuid);
    if (!card) continue;
    matchedWeight += weight;
    rarityFractionRaw[card.rarity] = (rarityFractionRaw[card.rarity] ?? 0) + weight;
    if (card.types?.includes("Land")) landWeight += weight;
    const scryfallId = card.identifiers?.scryfallId;
    if (scryfallId) cards.push({ scryfallId, weight, foil });
  }
  const matchedFraction = matchedWeight / totalWeight;
  const rarityFraction = {};
  for (const [rarity, weight] of Object.entries(rarityFractionRaw)) {
    rarityFraction[rarity] = matchedWeight > 0 ? weight / matchedWeight : 0;
  }
  return { rarityFraction, landFraction: matchedWeight > 0 ? landWeight / matchedWeight : 0, matchedFraction, foil, cards };
}

function classifySheet(stats) {
  if (stats.matchedFraction < 0.5) return "unknown";
  if (stats.landFraction > 0.5) return "land";
  const common = stats.rarityFraction.common ?? 0;
  const uncommon = stats.rarityFraction.uncommon ?? 0;
  const rareMythic = (stats.rarityFraction.rare ?? 0) + (stats.rarityFraction.mythic ?? 0);
  if (common >= 0.95) return "common";
  if (uncommon >= 0.95) return "uncommon";
  if (rareMythic >= 0.95) return "rareMythic";
  return stats.foil ? "wildcardFoil" : "wildcardNonfoil";
}

const SLOT_LABEL = {
  common: "確定コモン",
  uncommon: "確定アンコモン",
  rareMythic: "レア/神話スロット",
  wildcardNonfoil: "ワイルドカード（非フォイル）",
  wildcardFoil: "ワイルドカード（フォイル）",
};

async function main() {
  console.log("対象セット一覧を取得中...");
  const slotDefRows = await supabaseGet("pack_slot_definitions?select=set_code,product_type");
  const targets = [...new Set(slotDefRows.map((r) => `${r.set_code}|${r.product_type}`))].map((k) => {
    const [set_code, product_type] = k.split("|");
    return { set_code, product_type, key: product_type === "collector_booster" ? "collector" : "play" };
  });
  console.log(`対象: ${targets.length}件（セット×商品種別）`);

  const setNames = await supabaseGet("sets?select=set_code,set_name");
  const setNameByCode = new Map(setNames.map((s) => [s.set_code, s.set_name]));

  const cardPoolCache = new Map();
  const cardRows = [];
  let ok = 0;
  for (const { set_code, product_type, key } of targets) {
    if (!cardPoolCache.has(set_code)) {
      const setName = setNameByCode.get(set_code) ?? set_code;
      const companionCodes = await fetchCompanionSetCodes(set_code, setName);
      cardPoolCache.set(set_code, await buildCardPool(set_code, companionCodes));
    }
    const cardByUuid = cardPoolCache.get(set_code);

    const res = await fetch(`https://mtgjson.com/api/v5/${set_code.toUpperCase()}.json`, { headers: FETCH_HEADERS });
    if (!res.ok) {
      console.log(`✗ ${set_code} [${product_type}]: MTGJSON取得失敗`);
      continue;
    }
    const mtgjson = await res.json();
    const booster = mtgjson.data.booster?.[key];
    if (!booster?.sheets || !booster?.boosters?.length) {
      console.log(`✗ ${set_code} [${product_type}]: booster定義なし`);
      continue;
    }
    const dominantBooster = [...booster.boosters].sort((a, b) => b.weight - a.weight)[0];

    let sheetsFound = 0;
    for (const sheetName of Object.keys(dominantBooster.contents)) {
      const stats = analyzeSheet(cardByUuid, booster.sheets, sheetName);
      if (!stats) continue;
      const kind = classifySheet(stats);
      if (kind === "land" || kind === "unknown") continue;
      const slotName = SLOT_LABEL[kind];
      for (const c of stats.cards) {
        cardRows.push({
          set_code,
          product_type,
          slot_name: slotName,
          scryfall_id: c.scryfallId,
          weight: c.weight,
          foil: c.foil,
        });
      }
      sheetsFound++;
    }
    if (sheetsFound > 0) {
      console.log(`✓ ${set_code} [${product_type}]: ${sheetsFound}シート`);
      ok++;
    } else {
      console.log(`✗ ${set_code} [${product_type}]: 対応シートなし`);
    }
  }

  // 同じカードが複数シート（例: "rareMythic"と"rareMythicWithShowcase"）に分かれて登場し、
  // どちらも同じslot_nameに分類されることがある。UNIQUE制約に(set_code,product_type,
  // slot_name,scryfall_id)を使っているため、そのままだと同一バッチ内で重複キーになり
  // upsertが失敗する。ウェイトを合算して1行にまとめる。
  const mergedByKey = new Map();
  for (const row of cardRows) {
    const key = `${row.set_code}|${row.product_type}|${row.slot_name}|${row.scryfall_id}`;
    const existing = mergedByKey.get(key);
    if (existing) existing.weight += row.weight;
    else mergedByKey.set(key, { ...row });
  }
  const mergedRows = [...mergedByKey.values()];

  console.log(
    `\npack_slot_cards投入: ${mergedRows.length}行（重複合算前${cardRows.length}行、${ok}/${targets.length}セット×商品種別）`,
  );
  await supabaseUpsert("pack_slot_cards", mergedRows, "set_code,product_type,slot_name,scryfall_id");
  console.log("完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
