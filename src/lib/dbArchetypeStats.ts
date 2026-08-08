import { supabase } from "./supabase";
import type { Format } from "./formats";
import type { ArchetypeRow } from "./sampleDeckData";
import { COLOR_ORDER, colorsFromManaCost } from "./manaColors";

// MTG Arenaのワイルドカード1枚あたりの実質価値をJPYに換算する目安。ワイルドカード4枚で
// レア1500円/神話レア3000円ぶんの購入プランを単価に割り戻した値。コモン・アンコモンは
// ワイルドカードがほぼ余るため0円扱いにする。
const ARENA_WILDCARD_JPY: Record<string, number> = {
  common: 0,
  uncommon: 0,
  rare: 1500 / 4,
  mythic: 3000 / 4,
};

function arenaPriceJpy(rarity: string | null | undefined): number {
  if (!rarity) return 0;
  return ARENA_WILDCARD_JPY[rarity] ?? 0;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * archetypes / decks（db/schema.sql）から実データのアーキタイプランキングを組み立てる。
 * periodDays（7/30/90）で指定した直近日数（トーナメント開催日基準）のデッキだけを集計対象にする。
 * 価格の中央値はcard_cheapest_price_snapshots（全プリント横断の最安値）から代表デッキ窓
 * （getMedianPriceByArchetype）でその場で計算する。価格が1件も出せないアーキタイプは
 * 中央値が出せず順位に出しても意味がないため除外する。
 * usageRatePctは「その期間・フォーマットの全デッキ数に対する、このアーキタイプの分類デッキ数」の割合。
 */
export async function getArchetypesFromDb(
  format: Format,
  periodDays: 7 | 30 | 90 = 30,
): Promise<ArchetypeRow[]> {
  const { data: archetypes, error: archetypeError } = await supabase
    .from("archetypes")
    .select("id, name, name_ja")
    .eq("format", format);

  if (archetypeError || !archetypes || archetypes.length === 0) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (periodDays - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Supabase/PostgRESTはデフォルトで1ページ最大1000件までしか返さないため、
  // デッキ数がそれを超えるフォーマット（Legacy等）でもtotalDecksが欠けないようページングする。
  const PAGE_SIZE = 1000;
  const decks: { id: number; archetype_id: number | null }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page } = await supabase
      .from("decks")
      .select("id, archetype_id, tournaments!inner(format, event_date)")
      .eq("tournaments.format", format)
      .gte("tournaments.event_date", cutoffStr)
      .range(offset, offset + PAGE_SIZE - 1);
    if (!page || page.length === 0) break;
    decks.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const totalDecks = decks.length;
  const deckCountByArchetype = new Map<number, number>();
  const deckIdsByArchetype = new Map<number, number[]>();
  const REPRESENTATIVE_CARD_DECK_WINDOW = 20;
  for (const deck of decks) {
    if (!deck.archetype_id) continue;
    deckCountByArchetype.set(deck.archetype_id, (deckCountByArchetype.get(deck.archetype_id) ?? 0) + 1);
    const ids = deckIdsByArchetype.get(deck.archetype_id) ?? [];
    if (ids.length < REPRESENTATIVE_CARD_DECK_WINDOW) {
      ids.push(deck.id);
      deckIdsByArchetype.set(deck.archetype_id, ids);
    }
  }

  // 代表カード選定・Arena換算・実勢価格中央値は、いずれも同じdeckIdsByArchetypeのメインボード
  // （deck_cards）を土台に計算する。以前はそれぞれが個別にdeck_cards/cardsを取得しており、
  // 同じ行を2〜3回問い合わせて直列に待っていた（デッキ数が多いフォーマットほど遅くなる主因
  // だった）。1回だけ共有取得し、互いに依存しない計算は並列化する。
  const sharedDeckCards = await fetchArchetypeDeckCards(deckIdsByArchetype);

  // Commanderはアーキタイプ名そのものが統率者名（"A / B"はパートナー）なので、
  // メインボードを走査するのではなく統率者自身の絵（パートナーなら2枚とも）を代表カードにする。
  const [{ art: artUrlsByArchetype, colors: colorsByArchetype }, arenaMedianByArchetype, medianPriceByArchetype] =
    await Promise.all([
      format === "Commander"
        ? getCommanderArtByArchetype(archetypes)
        : Promise.resolve(getRepresentativeArtByArchetype(deckIdsByArchetype, sharedDeckCards)),
      // MTG Arenaで実際に組む対象はローテーション中のStandardが中心なため、換算はStandardのみ計算する
      format === "Standard"
        ? getArenaMedianByArchetype(deckIdsByArchetype, sharedDeckCards)
        : Promise.resolve(new Map<number, number>()),
      getMedianPriceByArchetype(deckIdsByArchetype, sharedDeckCards),
    ]);

  const rows = archetypes
    .map((a) => {
      const price = medianPriceByArchetype.get(a.id);
      if (!price) return null;
      const deckCount = deckCountByArchetype.get(a.id) ?? 0;
      const artUrls = artUrlsByArchetype.get(a.id) ?? [];
      return {
        archetypeId: String(a.id),
        nameJa: a.name_ja ?? a.name,
        nameEn: a.name,
        medianPriceJpy: price.medianPriceJpy,
        usageRatePct: totalDecks > 0 ? Math.round((deckCount / totalDecks) * 10000) / 100 : 0,
        sampleSize: price.sampleSize,
        arenaMedianPriceJpy: arenaMedianByArchetype.get(a.id),
        colors: colorsByArchetype.get(a.id) ?? [],
        representativeArtUrl: artUrls[0] ?? null,
        representativeArtUrls: artUrls.length > 1 ? artUrls : undefined,
      };
    })
    .filter((r) => r !== null) as ArchetypeRow[];
  rows.sort((a, b) => b.usageRatePct - a.usageRatePct);

  return rows;
}

/**
 * Commander用: アーキタイプ名＝統率者名（パートナーは" / "区切り）それぞれの絵を代表カードにする。
 * 両面カードの統率者は名前が"表面 // 裏面"になっており、card_oracles.nameは表面名のみで
 * 保持しているため、参照時は" // "より前（表面）だけを使う。
 */
async function getCommanderArtByArchetype(
  archetypes: { id: number; name: string }[],
): Promise<{ art: Map<number, string[]>; colors: Map<number, string[]> }> {
  const frontFaceName = (name: string) => name.split(" // ")[0];
  const commanderNames = [...new Set(archetypes.flatMap((a) => a.name.split(" / ").map(frontFaceName)))];
  if (commanderNames.length === 0) return { art: new Map(), colors: new Map() };

  // Commanderは統率者ごとに別アーキタイプになるため名前の種類数が数百件に及ぶ。.in()に
  // 全件まとめて渡すとURLが長すぎてPostgRESTが400を返し、結果が丸ごと（画像も色も）
  // サイレントに欠落する事故が実際に起きていた。チャンク分割して問い合わせる。
  const NAME_CHUNK = 150;
  const oracles: { oracle_id: string; name: string }[] = [];
  for (let i = 0; i < commanderNames.length; i += NAME_CHUNK) {
    const chunk = commanderNames.slice(i, i + NAME_CHUNK);
    const { data, error } = await supabase.from("card_oracles").select("oracle_id, name").in("name", chunk);
    if (error) continue;
    if (data) oracles.push(...data);
  }
  if (oracles.length === 0) return { art: new Map(), colors: new Map() };

  const oracleIdByName = new Map(oracles.map((o) => [o.name, o.oracle_id]));
  const oracleIds = oracles.map((o) => o.oracle_id);
  const cards: { oracle_id: string; image_uri_art_crop: string | null; mana_cost: string | null }[] = [];
  for (let i = 0; i < oracleIds.length; i += NAME_CHUNK) {
    const chunk = oracleIds.slice(i, i + NAME_CHUNK);
    const { data, error } = await supabase
      .from("cards")
      .select("oracle_id, image_uri_art_crop, mana_cost")
      .eq("lang", "en")
      .in("oracle_id", chunk);
    if (error) continue;
    if (data) cards.push(...data);
  }

  const artByOracleId = new Map(cards.map((c) => [c.oracle_id, c.image_uri_art_crop]));
  const manaCostByOracleId = new Map(cards.map((c) => [c.oracle_id, c.mana_cost]));

  const art = new Map<number, string[]>();
  const colors = new Map<number, string[]>();
  for (const a of archetypes) {
    const oracleIds = a.name.split(" / ").map((name) => oracleIdByName.get(frontFaceName(name)));
    const urls = oracleIds.map((id) => (id ? artByOracleId.get(id) : null)).filter((u): u is string => !!u);
    if (urls.length > 0) art.set(a.id, urls);

    const archetypeColors = new Set<string>();
    for (const id of oracleIds) {
      if (!id) continue;
      for (const c of colorsFromManaCost(manaCostByOracleId.get(id))) archetypeColors.add(c);
    }
    colors.set(a.id, COLOR_ORDER.filter((c) => archetypeColors.has(c)));
  }
  return { art, colors };
}

type ArchetypeDeckCard = { deck_id: number; oracle_id: string | null; quantity: number };

/**
 * getRepresentativeArtByArchetype・getArenaMedianByArchetype・getMedianPriceByArchetypeが
 * 共通で使うdeckIdsByArchetypeのメインボード（deck_cards）を1回だけ取得する。
 */
async function fetchArchetypeDeckCards(deckIdsByArchetype: Map<number, number[]>): Promise<ArchetypeDeckCard[]> {
  const allDeckIds = [...deckIdsByArchetype.values()].flat();
  if (allDeckIds.length === 0) return [];

  const PAGE_SIZE = 200;
  // Supabase/PostgRESTは1リクエスト最大1000行までしか返さない。200デッキ×60枚前後の
  // メインボードは軽く1000行を超えるため、chunk内でも.range()でページングしないと
  // 一部のデッキ（＝一部のアーキタイプ）のカードが黙って欠落し、代表カードが選べなくなる。
  const ROW_PAGE_SIZE = 1000;
  const chunks: number[][] = [];
  for (let i = 0; i < allDeckIds.length; i += PAGE_SIZE) chunks.push(allDeckIds.slice(i, i + PAGE_SIZE));

  // チャンク・ページはいずれも互いに独立なので並列取得する
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const pages: ArchetypeDeckCard[] = [];
      for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
        const { data } = await supabase
          .from("deck_cards")
          .select("deck_id, oracle_id, quantity")
          .in("deck_id", chunk)
          .eq("board", "main")
          .range(offset, offset + ROW_PAGE_SIZE - 1);
        if (!data || data.length === 0) break;
        pages.push(...data);
        if (data.length < ROW_PAGE_SIZE) break;
      }
      return pages;
    }),
  );
  return chunkResults.flat();
}

/**
 * アーキタイプごとの代表カード（そのアーキタイプのサンプルデッキで最も多く採用されている
 * 非土地カード）のアートクロップ画像を1枚選ぶ。MTGGoldfish風のカードアートグリッド表示用。
 */
async function getRepresentativeArtByArchetype(
  deckIdsByArchetype: Map<number, number[]>,
  deckCards: ArchetypeDeckCard[],
): Promise<{ art: Map<number, string[]>; colors: Map<number, string[]> }> {
  if (deckCards.length === 0) return { art: new Map(), colors: new Map() };
  const PAGE_SIZE = 200;

  const deckIdToArchetypeId = new Map<number, number>();
  for (const [archetypeId, deckIds] of deckIdsByArchetype) {
    for (const id of deckIds) deckIdToArchetypeId.set(id, archetypeId);
  }

  // 「何件のデッキに採用されているか（採用率）」と「1デッキあたり何枚積まれているか（プレイセット度）」の
  // 両方を見る。1枚だけの汎用ピン刺しカードが、4枚積みのアーキタイプの核となるカードより
  // 優先されてしまわないよう、デッキ数×平均枚数のスコアで順位付けする。
  const statsByArchetype = new Map<number, Map<string, { deckCount: number; totalQuantity: number }>>();
  const seenDecks = new Set<string>();
  for (const dc of deckCards) {
    if (!dc.oracle_id) continue;
    const archetypeId = deckIdToArchetypeId.get(dc.deck_id);
    if (archetypeId === undefined) continue;
    const byOracle = statsByArchetype.get(archetypeId) ?? new Map<string, { deckCount: number; totalQuantity: number }>();
    const stat = byOracle.get(dc.oracle_id) ?? { deckCount: 0, totalQuantity: 0 };
    stat.totalQuantity += dc.quantity;
    const deckKey = `${archetypeId}|${dc.deck_id}|${dc.oracle_id}`;
    if (!seenDecks.has(deckKey)) {
      seenDecks.add(deckKey);
      stat.deckCount += 1;
    }
    byOracle.set(dc.oracle_id, stat);
    statsByArchetype.set(archetypeId, byOracle);
  }

  const allOracleIds = [...new Set(deckCards.map((dc) => dc.oracle_id).filter((id): id is string => !!id))];
  const cardInfoByOracle = new Map<
    string,
    { typeLine: string | null; artCropUrl: string | null; manaCost: string | null }
  >();
  for (let i = 0; i < allOracleIds.length; i += PAGE_SIZE) {
    const chunk = allOracleIds.slice(i, i + PAGE_SIZE);
    const { data } = await supabase
      .from("cards")
      .select("oracle_id, type_line, image_uri_art_crop, mana_cost")
      .eq("lang", "en")
      .in("oracle_id", chunk);
    for (const c of data ?? []) {
      cardInfoByOracle.set(c.oracle_id, {
        typeLine: c.type_line,
        artCropUrl: c.image_uri_art_crop,
        manaCost: c.mana_cost,
      });
    }
  }

  const art = new Map<number, string[]>();
  const colors = new Map<number, string[]>();
  for (const [archetypeId, byOracle] of statsByArchetype) {
    // サンプルデッキ全体での採用枚数の合計をスコアにする。1枚だけの汎用ピン刺しカードは
    // 何デッキに入っていても合計枚数が伸びにくく、4枚積みの核となるカードが自然に上位に来る。
    const ranked = [...byOracle.entries()]
      .map(([oracleId, stat]) => ({
        oracleId,
        score: stat.totalQuantity,
        info: cardInfoByOracle.get(oracleId),
      }))
      .filter((r) => r.info?.artCropUrl && !r.info.typeLine?.includes("Land"))
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 0) art.set(archetypeId, [ranked[0].info!.artCropUrl!]);

    // 色は非土地カード全体の採用枚数を重みにして集計し、ノイズ（タッチ1枚だけの
    // オフカラー除去呪文等）を除くため、最大色の10%未満しか無い色は除外する。
    const colorWeight = new Map<string, number>();
    for (const r of ranked) {
      for (const c of colorsFromManaCost(r.info?.manaCost)) {
        colorWeight.set(c, (colorWeight.get(c) ?? 0) + r.score);
      }
    }
    const maxWeight = Math.max(0, ...colorWeight.values());
    if (maxWeight > 0) {
      const archetypeColors = COLOR_ORDER.filter((c) => (colorWeight.get(c) ?? 0) >= maxWeight * 0.1);
      colors.set(archetypeId, archetypeColors);
    }
  }
  return { art, colors };
}

/**
 * アーキタイプごとのMTG Arenaワイルドカード換算デッキ合計（中央値）。
 * scripts/compute-deck-stats.mjsのarchetype_price_stats（実勢価格の中央値）と同じ考え方で、
 * 直近デッキ（deckIdsByArchetypeの代表ウィンドウ、最大20件）それぞれのメインボードを
 * レアリティ別ワイルドカード単価×枚数で合計し、その中央値をアーキタイプの代表値にする。
 */
async function getArenaMedianByArchetype(
  deckIdsByArchetype: Map<number, number[]>,
  deckCards: ArchetypeDeckCard[],
): Promise<Map<number, number>> {
  if (deckCards.length === 0) return new Map();
  const PAGE_SIZE = 200;

  const allOracleIds = [...new Set(deckCards.map((dc) => dc.oracle_id).filter((id): id is string => !!id))];
  const rarityByOracle = new Map<string, string>();
  for (let i = 0; i < allOracleIds.length; i += PAGE_SIZE) {
    const chunk = allOracleIds.slice(i, i + PAGE_SIZE);
    const { data } = await supabase.from("cards").select("oracle_id, rarity").eq("lang", "en").in("oracle_id", chunk);
    for (const c of data ?? []) {
      if (c.rarity) rarityByOracle.set(c.oracle_id, c.rarity);
    }
  }

  const deckIdToArchetypeId = new Map<number, number>();
  for (const [archetypeId, deckIds] of deckIdsByArchetype) {
    for (const id of deckIds) deckIdToArchetypeId.set(id, archetypeId);
  }

  const totalByDeck = new Map<number, number>();
  for (const dc of deckCards) {
    if (!dc.oracle_id) continue;
    const price = arenaPriceJpy(rarityByOracle.get(dc.oracle_id));
    totalByDeck.set(dc.deck_id, (totalByDeck.get(dc.deck_id) ?? 0) + price * dc.quantity);
  }

  const totalsByArchetype = new Map<number, number[]>();
  for (const [deckId, total] of totalByDeck) {
    const archetypeId = deckIdToArchetypeId.get(deckId);
    if (archetypeId === undefined) continue;
    const list = totalsByArchetype.get(archetypeId) ?? [];
    list.push(total);
    totalsByArchetype.set(archetypeId, list);
  }

  const result = new Map<number, number>();
  for (const [archetypeId, totals] of totalsByArchetype) {
    result.set(archetypeId, Math.round(median(totals)));
  }
  return result;
}

/**
 * アーキタイプごとの実勢デッキ価格の中央値（円）。scripts/compute-deck-stats.mjsの
 * archetype_price_statsと同じ考え方だが、periodDaysで絞り込んだ代表デッキ窓
 * （deckIdsByArchetype、最大20件）をその場で集計する。カード詳細ページ・デッキランキングの
 * メイン価格と同じ基準に揃えるため、card_cheapest_price_snapshots（全プリント横断の最安値）
 * の最新日の値を使う。
 */
async function getMedianPriceByArchetype(
  deckIdsByArchetype: Map<number, number[]>,
  deckCards: ArchetypeDeckCard[],
): Promise<Map<number, { medianPriceJpy: number; sampleSize: number }>> {
  if (deckCards.length === 0) return new Map();
  const PAGE_SIZE = 200;

  const allOracleIds = [...new Set(deckCards.map((dc) => dc.oracle_id).filter((id): id is string => !!id))];
  const priceByOracle = new Map<string, number>();
  for (let i = 0; i < allOracleIds.length; i += PAGE_SIZE) {
    const chunk = allOracleIds.slice(i, i + PAGE_SIZE);
    // date降順なので最初に出てきた行がoracle_idごとの最新スナップショット
    const { data } = await supabase.from("card_current_prices").select("oracle_id, jpy_est").in("oracle_id", chunk);
    for (const p of data ?? []) {
      if (p.jpy_est !== null) priceByOracle.set(p.oracle_id, Number(p.jpy_est));
    }
  }

  const deckIdToArchetypeId = new Map<number, number>();
  for (const [archetypeId, deckIds] of deckIdsByArchetype) {
    for (const id of deckIds) deckIdToArchetypeId.set(id, archetypeId);
  }

  const totalByDeck = new Map<number, number>();
  const hasPriceByDeck = new Map<number, boolean>();
  for (const dc of deckCards) {
    if (!dc.oracle_id) continue;
    const price = priceByOracle.get(dc.oracle_id);
    if (price == null) continue;
    hasPriceByDeck.set(dc.deck_id, true);
    totalByDeck.set(dc.deck_id, (totalByDeck.get(dc.deck_id) ?? 0) + price * dc.quantity);
  }

  const totalsByArchetype = new Map<number, number[]>();
  for (const [deckId, hasPrice] of hasPriceByDeck) {
    if (!hasPrice) continue;
    const archetypeId = deckIdToArchetypeId.get(deckId);
    if (archetypeId === undefined) continue;
    const list = totalsByArchetype.get(archetypeId) ?? [];
    list.push(totalByDeck.get(deckId) ?? 0);
    totalsByArchetype.set(archetypeId, list);
  }

  const result = new Map<number, { medianPriceJpy: number; sampleSize: number }>();
  for (const [archetypeId, totals] of totalsByArchetype) {
    result.set(archetypeId, { medianPriceJpy: Math.round(median(totals)), sampleSize: totals.length });
  }
  return result;
}
