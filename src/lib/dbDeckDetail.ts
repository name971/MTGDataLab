import { supabase } from "./supabase";

export interface DbDeckCard {
  oracleId: string | null;
  nameEn: string;
  nameJa: string | null;
  artCropUrl: string | null;
  imageNormalUrl: string | null;
  priceJpy: number | null;
  typeLine: string | null;
  manaCost: string | null;
  quantity: number;
  board: "main" | "side";
}

export interface DbDeckDetail {
  eventName: string;
  format: string;
  playerName: string;
  standing: string;
  cards: DbDeckCard[];
}

export interface RecentDeckSummary {
  deckId: number;
  playerName: string;
  standing: string;
  eventName: string;
  format: string;
}

export interface ArchetypeInfo {
  id: number;
  format: string;
  nameJa: string | null;
  nameEn: string;
}

/** archetypes.id からフォーマット・名前を引く（/decks/archetype/[archetypeId] 用） */
export async function getArchetypeById(archetypeId: number): Promise<ArchetypeInfo | null> {
  const { data, error } = await supabase
    .from("archetypes")
    .select("id, format, name, name_ja")
    .eq("id", archetypeId)
    .maybeSingle();

  if (error || !data) return null;
  return { id: data.id, format: data.format, nameJa: data.name_ja, nameEn: data.name };
}

/** 指定アーキタイプに分類された実デッキ一覧（/decks/archetype/[archetypeId] 用） */
export async function getDecksByArchetypeId(archetypeId: number): Promise<RecentDeckSummary[]> {
  const { data, error } = await supabase
    .from("decks")
    .select("id, player_name, standing, tournaments!inner(event_name, format)")
    .eq("archetype_id", archetypeId)
    .order("id", { ascending: false });

  if (error || !data) return [];

  return data.map((d) => {
    const tournament = Array.isArray(d.tournaments) ? d.tournaments[0] : d.tournaments;
    return {
      deckId: d.id,
      playerName: d.player_name,
      standing: d.standing,
      eventName: tournament?.event_name ?? "",
      format: tournament?.format ?? "",
    };
  });
}

/**
 * 指定カード（oracle_id）・フォーマットで、直近periodDays日間に使われたデッキの一覧を返す
 * （/cards/[oracleId]/decks ページ用。使用デッキ件数の内訳表示）。
 * dbCardUsageByFormat.getFormatUsageCountsForCardと同じウィンドウの取り方で揃える。
 */
export async function getDecksByCardAndFormat(
  oracleId: string,
  format: string,
  periodDays: number = 7,
): Promise<RecentDeckSummary[]> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (periodDays - 1));
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("deck_cards")
    .select(
      "deck_id, decks!inner(id, player_name, standing, tournaments!inner(event_name, format, event_date))",
    )
    .eq("oracle_id", oracleId)
    .eq("decks.tournaments.format", format)
    .gte("decks.tournaments.event_date", isoDate(start))
    .lte("decks.tournaments.event_date", isoDate(end));

  if (error || !data) return [];

  const byDeckId = new Map<number, RecentDeckSummary>();
  for (const row of data) {
    const deck = Array.isArray(row.decks) ? row.decks[0] : row.decks;
    if (!deck) continue;
    const tournament = Array.isArray(deck.tournaments) ? deck.tournaments[0] : deck.tournaments;
    if (!tournament || byDeckId.has(deck.id)) continue;
    byDeckId.set(deck.id, {
      deckId: deck.id,
      playerName: deck.player_name,
      standing: deck.standing,
      eventName: tournament.event_name,
      format: tournament.format,
    });
  }
  return [...byDeckId.values()];
}

/** 最近インポートされた実トーナメント戦績デッキの一覧（/decks ページ用） */
export async function getRecentDecksFromDb(format?: string): Promise<RecentDeckSummary[]> {
  let query = supabase
    .from("decks")
    .select("id, player_name, standing, tournaments!inner(event_name, format)")
    .order("id", { ascending: false })
    .limit(20);

  if (format) {
    query = query.eq("tournaments.format", format);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((d) => {
    const tournament = Array.isArray(d.tournaments) ? d.tournaments[0] : d.tournaments;
    return {
      deckId: d.id,
      playerName: d.player_name,
      standing: d.standing,
      eventName: tournament?.event_name ?? "",
      format: tournament?.format ?? "",
    };
  });
}

/**
 * decks / deck_cards / tournaments（db/schema.sql、scripts/import-tournaments.mjsで投入）から
 * 実際のトーナメント戦績デッキを取得する。deck_cards.oracle_idが解決できているカードは
 * card_oracles/cardsから日本語名・画像も補うが、名寄せ未解決のカードは英語名のみになる
 * （TopDeck.ggの実データはcard_oraclesにまだ全件インポートされていないため、多くは未解決）。
 */
export async function getDeckDetailFromDb(deckId: number): Promise<DbDeckDetail | null> {
  const { data: deck, error: deckError } = await supabase
    .from("decks")
    .select("id, player_name, standing, tournament_id, tournaments(event_name, format)")
    .eq("id", deckId)
    .maybeSingle();

  if (deckError || !deck) return null;

  const { data: cards, error: cardsError } = await supabase
    .from("deck_cards")
    .select("card_name, oracle_id, board, quantity")
    .eq("deck_id", deckId);

  if (cardsError || !cards) return null;

  const oracleIds = [...new Set(cards.map((c) => c.oracle_id).filter((id): id is string => !!id))];
  const oracleInfo = new Map<
    string,
    {
      printedNameJa: string | null;
      artCropUrl: string | null;
      imageNormalUrl: string | null;
      typeLine: string | null;
      manaCost: string | null;
    }
  >();
  const priceByOracle = new Map<string, number>();

  if (oracleIds.length > 0) {
    const { data: oracles } = await supabase
      .from("card_oracles")
      .select("oracle_id, printed_name_ja")
      .in("oracle_id", oracleIds);
    const { data: cardRows } = await supabase
      .from("cards")
      .select("oracle_id, lang, image_uri_art_crop, image_uri_normal, type_line, mana_cost")
      .in("oracle_id", oracleIds);
    const { data: priceRows } = await supabase
      .from("card_price_snapshots")
      .select("oracle_id, jpy_est, date")
      .in("oracle_id", oracleIds)
      .eq("series", "en")
      .order("date", { ascending: false });

    for (const o of oracles ?? []) {
      oracleInfo.set(o.oracle_id, {
        printedNameJa: o.printed_name_ja,
        artCropUrl: null,
        imageNormalUrl: null,
        typeLine: null,
        manaCost: null,
      });
    }
    for (const c of cardRows ?? []) {
      const existing = oracleInfo.get(c.oracle_id);
      if (existing && c.image_uri_art_crop && (c.lang === "ja" || !existing.artCropUrl)) {
        existing.artCropUrl = c.image_uri_art_crop;
      }
      if (existing && c.image_uri_normal && (c.lang === "ja" || !existing.imageNormalUrl)) {
        existing.imageNormalUrl = c.image_uri_normal;
      }
      if (existing && c.type_line && (c.lang === "en" || !existing.typeLine)) {
        existing.typeLine = c.type_line;
      }
      // マナコストは英語版の値で統一する（日本語版でも同じはずだが、表記ゆれを避けるため）
      if (existing && c.mana_cost && (c.lang === "en" || !existing.manaCost)) {
        existing.manaCost = c.mana_cost;
      }
    }
    // date降順なので最初に出てきた行がoracle_idごとの最新スナップショット
    for (const p of priceRows ?? []) {
      if (!priceByOracle.has(p.oracle_id)) priceByOracle.set(p.oracle_id, Number(p.jpy_est));
    }
  }

  const tournament = Array.isArray(deck.tournaments) ? deck.tournaments[0] : deck.tournaments;

  return {
    eventName: tournament?.event_name ?? "",
    format: tournament?.format ?? "",
    playerName: deck.player_name,
    standing: deck.standing,
    cards: cards.map((c) => {
      const info = c.oracle_id ? oracleInfo.get(c.oracle_id) : undefined;
      return {
        oracleId: c.oracle_id ?? null,
        nameEn: c.card_name,
        nameJa: info?.printedNameJa ?? null,
        artCropUrl: info?.artCropUrl ?? null,
        imageNormalUrl: info?.imageNormalUrl ?? null,
        priceJpy: c.oracle_id ? priceByOracle.get(c.oracle_id) ?? null : null,
        typeLine: info?.typeLine ?? null,
        manaCost: info?.manaCost ?? null,
        quantity: c.quantity,
        board: c.board,
      };
    }),
  };
}
