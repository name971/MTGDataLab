/**
 * Play/Collector Booster採用セット（2023年秋 Wilds of Eldraine以降）全てについて、
 * 1) MTGJSON（https://mtgjson.com/api/v5/{SET}.json）のbooster.play/collector.sheetsから
 *    実際の排出ウェイトテーブルを集計してスロット確率を算出し、pack_slot_definitions
 *    （db/schema.sql、内訳表示の監査用途のみ・EV計算はsrc/lib/samplePackData.ts側で完結）
 *    に投入する。
 * 2) Scryfallのバルクデータから、そのセットの各カード印刷（scryfallId単位）のUSD価格を
 *    引き、シートのfoilフラグに応じてusd/usd_foilを使い分けてスロット単価を算出する。
 *    scryfallIdは印刷そのものを指すため、showcase・extended art等の特殊枠もその印刷固有の
 *    価格が引かれる（レアリティ平均に丸め込まれない）。src/lib/samplePackData.tsの
 *    SAMPLE_SETS/COLLECTOR_SAMPLE_SETSを丸ごと生成し直す
 *    （このファイルは「パックEVでどのセットを一覧表示するか」のカタログを兼ねる）。
 * 3) パック価格はWotC公式MSRPの決め打ちではなく、TCGCSV（tcgcsv.com、TCGplayerの
 *    カテゴリ/グループ/商品/価格データを認証不要で日次公開している）から、そのセットの
 *    「Play/Collector Booster Pack」単品のmarketPrice（実勢価格）を取得して使う。
 *    Universes Beyond系（Marvel等）はライセンス料の影響で通常セットより単パックが高い
 *    ことが多く、一律のMSRPでは実態とズレるため。
 *
 * 手作業だった算出方法（元のsamplePackData.tsのコメント参照）を全セットに一般化したもの。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/generate-pack-data.mjs
 */

import { ensureBulkData, DATA_FILE, forEachJsonArrayObject } from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; jp-mtgstocks/0.1)" };
const WOE_RELEASE = "2023-09-08";
const TCGCSV_MAGIC_CATEGORY_ID = 1;

let tcgcsvGroupsCache = null;
async function fetchTcgcsvGroups() {
  if (tcgcsvGroupsCache) return tcgcsvGroupsCache;
  const res = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/groups`, {
    headers: FETCH_HEADERS,
  });
  const data = await res.json();
  tcgcsvGroupsCache = data.results;
  return tcgcsvGroupsCache;
}

/**
 * TCGCSVからそのセットの「Play/Collector Booster Pack」単品のmarketPrice（実勢価格、USD）を取得する。
 * グループはabbreviationがセットコードと完全一致するもの（"Commander: X"や"Art Series: X"等の
 * 派生グループはabbreviationが別物になるので誤って拾わない）。見つからなければnullを返す
 * （呼び出し側でスキップ判断する）。
 */
async function fetchPackMarketInfo(setCode, productType) {
  const groups = await fetchTcgcsvGroups();
  const group = groups.find((g) => g.abbreviation?.toLowerCase() === setCode.toLowerCase());
  if (!group) return null;

  const nameRegex = productType === "collector" ? /collector booster pack/i : /play booster pack/i;

  const prodRes = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/${group.groupId}/products`, {
    headers: FETCH_HEADERS,
  });
  const prodData = await prodRes.json();
  const pack = prodData.results.find((p) => nameRegex.test(p.name) && !/sleeved|display/i.test(p.name));
  if (!pack) return null;

  const priceRes = await fetch(`https://tcgcsv.com/tcgplayer/${TCGCSV_MAGIC_CATEGORY_ID}/${group.groupId}/prices`, {
    headers: FETCH_HEADERS,
  });
  const priceData = await priceRes.json();
  const price = priceData.results.find((r) => r.productId === pack.productId);
  const priceUsd = price?.marketPrice ?? price?.midPrice ?? null;
  if (priceUsd === null) return null;
  return { priceUsd, imageUrl: pack.imageUrl ?? null };
}

async function supabaseUpsert(table, rows, conflictColumn) {
  if (rows.length === 0) return;
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

async function fetchExchangeRate() {
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
  const data = await res.json();
  return data.rates.JPY;
}

/**
 * Scryfallバルクデータから、指定セット群（ベースセット＋関連セット）のカードの
 * scryfallId単位の価格表（USD、非フォイル/フォイルそれぞれ）を作る。MTGJSONの各カードは
 * identifiers.scryfallIdでScryfallの「その印刷そのもの」を一意に指せるため、oracle_id単位の
 * 重複排除（旧実装）と違い、showcase版・extended art版などの特殊枠も他の印刷と混同せず
 * 正確にその印刷の価格を引ける。
 */
async function computeScryfallPriceMap(setCodes) {
  const codeSet = new Set(setCodes.map((c) => c.toLowerCase()));
  const priceById = new Map();
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    if (raw.lang !== "en" || !codeSet.has(raw.set)) return;
    priceById.set(raw.id, {
      usd: raw.prices?.usd ? parseFloat(raw.prices.usd) : null,
      usdFoil: raw.prices?.usd_foil ? parseFloat(raw.prices.usd_foil) : null,
    });
  });
  return priceById;
}

let setListCache = null;
async function fetchSetList() {
  if (setListCache) return setListCache;
  const res = await fetch("https://mtgjson.com/api/v5/SetList.json", { headers: FETCH_HEADERS });
  const data = await res.json();
  setListCache = data.data;
  return setListCache;
}

/**
 * ベースセット名と無関係な独自ブランド名がついた便乗特典セットは、名前一致では
 * 検出できない（例: サンダー・ジャンクションの"The Big Score"/"Breaking News"、
 * Marvel系セットの原作コマ特典"Marvel Universe"、LCIの"Jurassic World Collection"）。
 * 件数が少ないため、判明した分だけここに列挙する（各コードはSetList.json+実データで
 * カード解決率100%になることを個別に確認済み）。
 */
const KNOWN_UNNAMED_COMPANIONS = {
  otj: ["BIG", "OTP", "SPG"], // The Big Score, Breaking News, Special Guests共通コード
  msh: ["MAR"], // Marvel Universe（原作コマ特典の共通プール）
  spm: ["MAR"],
  lci: ["REX"], // Jurassic World Collection
};

/**
 * Collector Boosterには、統率者デッキ（"{セット名} Commander"）や原作コラボ特殊枠
 * （"{セット名} Source Material"等）から引用されたボーナスカードが混ざることがあり、
 * そのuuidはベースセット本体のMTGJSONデータには存在しない。セットごとに関連製品名を
 * 決め打ちで管理するのは大変なので、SetList.jsonから「ベースセット名を含む別セット」を
 * 関連セットとして機械的に検出し、それらのカードプールも一緒に読み込むことで解決する
 * （検出できない例外はKNOWN_UNNAMED_COMPANIONSで個別に補う）。
 */
async function fetchCompanionSetCodes(setCode, setName) {
  const setList = await fetchSetList();
  const byName = setList
    .filter((s) => s.code.toUpperCase() !== setCode.toUpperCase() && s.name.includes(setName))
    .map((s) => s.code);
  const known = KNOWN_UNNAMED_COMPANIONS[setCode.toLowerCase()] ?? [];
  return [...new Set([...byName, ...known])];
}

/**
 * ベースセット＋関連セット（統率者デッキ等）のMTGJSONカードデータをuuid単位でマージした
 * プールを作る。analyzeSheetがCollector Boosterのボーナスシート（他セット由来カード）も
 * 解決できるようにするため。
 */
async function buildCardPool(setCode, companionCodes) {
  const cardByUuid = new Map();
  for (const code of [setCode, ...companionCodes]) {
    const res = await fetch(`https://mtgjson.com/api/v5/${code.toUpperCase()}.json`, {
      headers: FETCH_HEADERS,
    });
    if (!res.ok) continue;
    const json = await res.json();
    for (const card of json.data.cards) cardByUuid.set(card.uuid, card);
  }
  return cardByUuid;
}

/**
 * MTGJSONのシート名はセットによって命名がバラバラ（例: "rareMythic" vs
 * "rareMythicWithShowcase"）なので名前では判定しない。代わりに、シートの中身の
 * レアリティ構成比・foilフラグ・土地カード比率という「実体」で分類する。
 *
 * Collector Boosterには、このセット本体ではなく統率者デッキ等の別セットから
 * 引用されたカード（例: BLBのcommanderCardシート、TMTのsurgeFoilCommanderシート等）が
 * 含まれることがある。呼び出し側のbuildCardPoolで関連セットのカードも事前にマージした
 * cardByUuidを渡す前提だが、それでも解決できないuuid（未知の関連セット等）が残る場合に
 * 備えて、「マッチできたカードの重み」を分母にして構成比を計算し、マッチ率
 * （matchedFraction）が低いシート（半分以上が未解決）は判定不能として呼び出し側で
 * スキップする（フォールバック的な安全策）。
 *
 * 価格はシートのfoilフラグに応じてそのカードのusd/usd_foilを使い分けて
 * 重み付き平均を取る（Collector Boosterはフォイル確定スロットが大半で、
 * フォイルは非フォイルよりかなり高いことが多いため区別が必須）。showcase等の
 * 特殊枠もMTGJSON側でscryfallIdが印刷単位で振られているため、自然と
 * その特殊枠自身の価格が引かれる（レアリティ平均に丸め込まれない）。
 */
function analyzeSheet(cardByUuid, sheets, sheetName, priceById) {
  const sheet = sheets?.[sheetName];
  if (!sheet) return null;
  const totalWeight = Object.values(sheet.cards).reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return null;

  const rarityFractionRaw = {};
  let landWeight = 0;
  let matchedWeight = 0;
  let priceWeightSum = 0;
  let priceMatchedWeight = 0;
  const foil = !!sheet.foil;
  for (const [uuid, weight] of Object.entries(sheet.cards)) {
    const card = cardByUuid.get(uuid);
    if (!card) continue;
    matchedWeight += weight;
    rarityFractionRaw[card.rarity] = (rarityFractionRaw[card.rarity] ?? 0) + weight;
    if (card.types?.includes("Land")) landWeight += weight;

    const scryfallId = card.identifiers?.scryfallId;
    const price = scryfallId ? priceById.get(scryfallId) : null;
    const usd = foil ? price?.usdFoil : price?.usd;
    if (usd != null) {
      priceWeightSum += usd * weight;
      priceMatchedWeight += weight;
    }
  }
  const matchedFraction = matchedWeight / totalWeight;
  const rarityFraction = {};
  for (const [rarity, weight] of Object.entries(rarityFractionRaw)) {
    rarityFraction[rarity] = matchedWeight > 0 ? weight / matchedWeight : 0;
  }
  return {
    rarityFraction,
    landFraction: matchedWeight > 0 ? landWeight / matchedWeight : 0,
    matchedFraction,
    avgPriceUsd: priceMatchedWeight > 0 ? priceWeightSum / priceMatchedWeight : 0,
    foil,
  };
}

/** レアリティ構成比・foilフラグから、そのシートが「確定コモン」等どの概念に当たるかを判定する */
function classifySheet(stats) {
  if (stats.matchedFraction < 0.5) return "unknown"; // 他セット由来カードが大半で判定不能
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

async function computeSlotsForSet(setCode, productType, cardByUuid, priceById, usdToJpy) {
  const res = await fetch(`https://mtgjson.com/api/v5/${setCode.toUpperCase()}.json`, {
    headers: FETCH_HEADERS,
  });
  if (!res.ok) return null;
  const mtgjson = await res.json();
  const booster = mtgjson.data.booster?.[productType];
  if (!booster?.sheets || !booster?.boosters?.length) return null;

  // 複数の排出パターン（ボーナス挿入版など）が重み付きで存在することがあるため、
  // 最も出現比率の高い「標準」パターンだけを採用する（簡略化）。
  const dominantBooster = [...booster.boosters].sort((a, b) => b.weight - a.weight)[0];

  const slotsByKind = new Map();
  for (const [sheetName, cardCount] of Object.entries(dominantBooster.contents)) {
    const stats = analyzeSheet(cardByUuid, booster.sheets, sheetName, priceById);
    if (!stats) continue;
    const kind = classifySheet(stats);
    // 土地スロット・判定不能スロット（他セット由来カード主体）は価格算出の対象外
    if (kind === "land" || kind === "unknown") continue;

    const probabilityByRarity =
      kind === "common"
        ? { common: 1 }
        : kind === "uncommon"
          ? { uncommon: 1 }
          : stats.rarityFraction;
    const avgPriceJpy = Math.round(stats.avgPriceUsd * usdToJpy);
    const matchRate = stats.matchedFraction;

    // 同じ種類のシートが複数回登場することは無い想定だが、念のためcardCountを合算する
    // （その場合、単価・マッチ率はcardCount重み付き平均で合成する）
    const existing = slotsByKind.get(kind);
    if (existing) {
      const totalCount = existing.cardCount + cardCount;
      existing.avgPriceJpy =
        (existing.avgPriceJpy * existing.cardCount + avgPriceJpy * cardCount) / totalCount;
      existing.matchRate =
        (existing.matchRate * existing.cardCount + matchRate * cardCount) / totalCount;
      existing.cardCount = totalCount;
    } else {
      slotsByKind.set(kind, { slotName: SLOT_LABEL[kind], cardCount, probabilityByRarity, avgPriceJpy, matchRate });
    }
  }

  const slots = [...slotsByKind.values()];
  const hasRareMythic = slots.some((s) => s.slotName === SLOT_LABEL.rareMythic);
  // Play Boosterは必ずワイルドカード枠を持つ構造なので、その存在を妥当性チェックに使う。
  // Collector Boosterはワイルドカード枠を持たない構成もある（例: BLB）ため、
  // レア/神話スロットの有無だけをチェックする。
  const hasWildcard = slots.some((s) => s.slotName === SLOT_LABEL.wildcardNonfoil || s.slotName === SLOT_LABEL.wildcardFoil);
  if (!hasRareMythic) return null;
  if (productType === "play" && !hasWildcard) return null;

  return slots;
}

async function main() {
  console.log("Scryfallセット一覧を取得中...");
  const setsRes = await fetch("https://api.scryfall.com/sets", { headers: FETCH_HEADERS });
  const setsData = await setsRes.json();
  const candidates = setsData.data.filter(
    (s) => ["expansion", "core"].includes(s.set_type) && !s.digital && s.released_at >= WOE_RELEASE,
  );
  console.log(`候補: ${candidates.length}セット`);

  await ensureBulkData();
  const usdToJpy = await fetchExchangeRate();
  console.log(`為替レート: 1USD=${usdToJpy}円`);

  const PRODUCT_TYPES = [
    { key: "play", label: "Play Booster", dbType: "play_booster" },
    { key: "collector", label: "Collector Booster", dbType: "collector_booster" },
  ];

  const sampleSetsByProduct = { play: [], collector: [] };
  const slotRows = [];
  const cardPoolCache = new Map();
  const priceMapCache = new Map();

  for (const { key, label, dbType } of PRODUCT_TYPES) {
    for (const set of candidates) {
      if (!cardPoolCache.has(set.code)) {
        const companionCodes = await fetchCompanionSetCodes(set.code, set.name);
        const [cardByUuid, priceById] = await Promise.all([
          buildCardPool(set.code, companionCodes),
          computeScryfallPriceMap([set.code, ...companionCodes]),
        ]);
        cardPoolCache.set(set.code, cardByUuid);
        priceMapCache.set(set.code, priceById);
      }
      const cardByUuid = cardPoolCache.get(set.code);
      const priceById = priceMapCache.get(set.code);

      const slots = await computeSlotsForSet(set.code, key, cardByUuid, priceById, usdToJpy);
      if (!slots) {
        console.log(`✗ ${set.code} (${set.name}) [${label}]: 対応なし、スキップ`);
        continue;
      }
      const packInfo = await fetchPackMarketInfo(set.code, key);
      if (packInfo === null) {
        console.log(`✗ ${set.code} (${set.name}) [${label}]: TCGCSVで単品の実勢価格が見つからず、スキップ`);
        continue;
      }
      sampleSetsByProduct[key].push({
        setCode: set.code,
        setName: set.name,
        releasedAt: set.released_at,
        packPriceJpy: Math.round(packInfo.priceUsd * usdToJpy),
        packImageUrl: packInfo.imageUrl,
        slots,
      });
      for (const slot of slots) {
        for (const [rarity, probability] of Object.entries(slot.probabilityByRarity)) {
          slotRows.push({
            set_code: set.code,
            product_type: dbType,
            slot_name: slot.slotName,
            rarity,
            probability,
            card_count: slot.cardCount,
          });
        }
      }
      console.log(`✓ ${set.code} (${set.name}) [${label}]`);
    }
  }

  console.log(`\npack_slot_definitions投入: ${slotRows.length}行`);
  await supabaseUpsert("pack_slot_definitions", slotRows, "set_code,product_type,slot_name,rarity");

  const fileContent = `/** pack_slot_definitions（db/schema.sql）に差し替え済みのセットは実データ、それ以外は
 * このファイルのslotsがフォールバックとして使われる（src/app/packs/page.tsx参照）。
 * scripts/generate-pack-data.mjsで自動生成（MTGJSON booster.play.sheets + Scryfall平均価格）。
 * 再生成: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/generate-pack-data.mjs
 */

export type Rarity = "common" | "uncommon" | "rare" | "mythic";

export interface PackSlot {
  slotName: string;
  cardCount: number;
  probabilityByRarity: Partial<Record<Rarity, number>>;
  /** そのスロット1枚あたりの期待価格（円）。スロットのfoilフラグに応じてusd/usd_foilを
   * 使い分けて算出済みなので、フォイル確定スロットのプレミアムやshowcase等特殊枠の実売価格
   * （scryfallIdの印刷単位で価格を引くため自然と反映される）も反映されている。 */
  avgPriceJpy: number;
  /** このスロットの排出カード（MTGJSONのuuid）のうち、実際のカードデータ（レアリティ・
   * 価格）まで解決できた割合。関連セット（統率者デッキ等）が未知の場合や、Scryfall側に
   * 該当印刷が無い場合に1.0未満になる。低いほどavgPriceJpy/probabilityByRarityの
   * 信頼度が下がる。 */
  matchRate: number;
}

export interface SampleSet {
  setCode: string;
  setName: string;
  releasedAt: string;
  packPriceJpy: number;
  packImageUrl: string | null;
  slots: PackSlot[];
}

/** 各スロットの「枚数 × スロット単価」を全スロットで合算する */
export function calculatePackEv(set: SampleSet): number {
  return set.slots.reduce((total, slot) => total + slot.cardCount * slot.avgPriceJpy, 0);
}

export const SAMPLE_SETS: SampleSet[] = ${JSON.stringify(sampleSetsByProduct.play, null, 2)};

export const COLLECTOR_SAMPLE_SETS: SampleSet[] = ${JSON.stringify(sampleSetsByProduct.collector, null, 2)};
`;

  const fs = await import("fs");
  fs.writeFileSync(new URL("../src/lib/samplePackData.ts", import.meta.url), fileContent, "utf8");
  console.log(
    `\nsrc/lib/samplePackData.ts をPlay Booster ${sampleSetsByProduct.play.length}セット・Collector Booster ${sampleSetsByProduct.collector.length}セット分で再生成しました`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
