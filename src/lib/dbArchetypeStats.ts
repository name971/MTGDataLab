import { supabase } from "./supabase";
import type { Format } from "./formats";
import type { ArchetypeRow } from "./sampleDeckData";
import { COLOR_ORDER, colorsFromManaCost } from "./manaColors";

/**
 * archetypes / archetype_price_stats / decks（db/schema.sql）から実データのアーキタイプ
 * ランキングを組み立てる。archetype_price_statsに価格が無いアーキタイプは除外する
 * （中央値が出せないカードは順位に出しても意味がないため）。
 * usageRatePctは「そのフォーマットの全デッキ数に対する、このアーキタイプの分類デッキ数」の割合。
 */
export async function getArchetypesFromDb(format: Format): Promise<ArchetypeRow[]> {
  const { data: archetypes, error: archetypeError } = await supabase
    .from("archetypes")
    .select("id, name, name_ja")
    .eq("format", format);

  if (archetypeError || !archetypes || archetypes.length === 0) return [];

  const archetypeIds = archetypes.map((a) => a.id);

  const { data: priceStats } = await supabase
    .from("archetype_price_stats")
    .select("archetype_id, median_price_jpy, sample_size, calculated_at")
    .in("archetype_id", archetypeIds)
    .order("calculated_at", { ascending: false });

  const latestPriceByArchetype = new Map<number, { medianPriceJpy: number; sampleSize: number }>();
  for (const row of priceStats ?? []) {
    if (!latestPriceByArchetype.has(row.archetype_id)) {
      latestPriceByArchetype.set(row.archetype_id, {
        medianPriceJpy: Number(row.median_price_jpy),
        sampleSize: row.sample_size,
      });
    }
  }

  // Supabase/PostgRESTはデフォルトで1ページ最大1000件までしか返さないため、
  // デッキ数がそれを超えるフォーマット（Legacy等）でもtotalDecksが欠けないようページングする。
  const PAGE_SIZE = 1000;
  const decks: { id: number; archetype_id: number | null }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page } = await supabase
      .from("decks")
      .select("id, archetype_id, tournaments!inner(format)")
      .eq("tournaments.format", format)
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
    if (!latestPriceByArchetype.has(deck.archetype_id)) continue;
    const ids = deckIdsByArchetype.get(deck.archetype_id) ?? [];
    if (ids.length < REPRESENTATIVE_CARD_DECK_WINDOW) {
      ids.push(deck.id);
      deckIdsByArchetype.set(deck.archetype_id, ids);
    }
  }

  // Commanderはアーキタイプ名そのものが統率者名（"A / B"はパートナー）なので、
  // メインボードを走査するのではなく統率者自身の絵（パートナーなら2枚とも）を代表カードにする。
  const { art: artUrlsByArchetype, colors: colorsByArchetype } =
    format === "Commander"
      ? await getCommanderArtByArchetype(archetypes)
      : await getRepresentativeArtByArchetype(deckIdsByArchetype);

  const rows: ArchetypeRow[] = archetypes
    .map((a) => {
      const price = latestPriceByArchetype.get(a.id);
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
        colors: colorsByArchetype.get(a.id) ?? [],
        representativeArtUrl: artUrls[0] ?? null,
        representativeArtUrls: artUrls.length > 1 ? artUrls : undefined,
      };
    })
    .filter((r): r is ArchetypeRow => r !== null)
    .sort((a, b) => b.usageRatePct - a.usageRatePct);

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

/**
 * アーキタイプごとの代表カード（そのアーキタイプのサンプルデッキで最も多く採用されている
 * 非土地カード）のアートクロップ画像を1枚選ぶ。MTGGoldfish風のカードアートグリッド表示用。
 */
async function getRepresentativeArtByArchetype(
  deckIdsByArchetype: Map<number, number[]>,
): Promise<{ art: Map<number, string[]>; colors: Map<number, string[]> }> {
  const allDeckIds = [...deckIdsByArchetype.values()].flat();
  if (allDeckIds.length === 0) return { art: new Map(), colors: new Map() };

  const PAGE_SIZE = 200;
  // Supabase/PostgRESTは1リクエスト最大1000行までしか返さない。200デッキ×60枚前後の
  // メインボードは軽く1000行を超えるため、chunk内でも.range()でページングしないと
  // 一部のデッキ（＝一部のアーキタイプ）のカードが黙って欠落し、代表カードが選べなくなる。
  const ROW_PAGE_SIZE = 1000;
  const deckCards: { deck_id: number; oracle_id: string | null; quantity: number }[] = [];
  for (let i = 0; i < allDeckIds.length; i += PAGE_SIZE) {
    const chunk = allDeckIds.slice(i, i + PAGE_SIZE);
    for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
      const { data } = await supabase
        .from("deck_cards")
        .select("deck_id, oracle_id, quantity")
        .in("deck_id", chunk)
        .eq("board", "main")
        .range(offset, offset + ROW_PAGE_SIZE - 1);
      if (!data || data.length === 0) break;
      deckCards.push(...data);
      if (data.length < ROW_PAGE_SIZE) break;
    }
  }

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
