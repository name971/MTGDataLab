/**
 * Scryfall API ヘルパー。
 * 日本語版プリントがあれば日本語名・日本語画像を優先し、なければ英語版にフォールバックする。
 * 参考: reference/prototype/prototype.html（動作確認済みの元実装）
 */

const SCRYFALL_BASE = "https://api.scryfall.com";

/** Scryfallはデフォルトの User-Agent を弾く（generic_user_agent）ため、独自の値を必ず送る */
const SCRYFALL_HEADERS = {
  "User-Agent": "jp-mtgstocks/0.1 (+https://github.com/jp-mtgstocks)",
  Accept: "application/json",
};

/**
 * DB未接続の現状、カード詳細ページはリクエストのたびにScryfallをライブで叩いている。
 * キャッシュなしだとアクセスが増えたときにレート制限に当たるため、Next.jsのfetchキャッシュで
 * 1時間だけ結果を再利用する（本来はDBの日次スナップショットを見るだけで済むはずの箇所）。
 */
const SCRYFALL_FETCH_OPTIONS = { next: { revalidate: 3600 } };

export interface ScryfallCard {
  id: string;
  oracle_id: string;
  name: string;
  printed_name?: string;
  /** タイプ行の日本語訳。日本語版プリントの一部にのみ存在する（無い版もある） */
  printed_type_line?: string;
  set_name: string;
  set: string;
  rarity: string;
  collector_number: string;
  lang: string;
  released_at: string;
  mana_cost?: string;
  type_line?: string;
  power?: string;
  toughness?: string;
  oracle_text?: string;
  printed_text?: string;
  legalities: Record<string, string>;
  finishes: string[];
  image_uris?: {
    normal: string;
    art_crop: string;
  };
  /** 両面カード（変身/分割等）は name/printed_name/image_uris がトップレベルではなく各面にある */
  card_faces?: {
    name: string;
    printed_name?: string;
    printed_type_line?: string;
    mana_cost?: string;
    type_line?: string;
    power?: string;
    toughness?: string;
    oracle_text?: string;
    printed_text?: string;
    image_uris?: {
      normal: string;
      art_crop: string;
    };
  }[];
  prices: {
    usd?: string | null;
    eur?: string | null;
  };
  /** "universesbeyond"が入っていると、コラボ作品向けにルールテキスト中のカード名が
   * フレーバー名（例: FF版Ragavanの"Zidane Tribal"）に差し替わっていることがある */
  promo_types?: string[];
}

/** 両面カードは表面（card_faces[0]）の画像を使う。通常カードはそのままトップレベルを使う */
export function resolveImageUris(card: ScryfallCard) {
  return card.image_uris ?? card.card_faces?.[0]?.image_uris ?? null;
}

/**
 * 両面カードのnameはScryfall上「表面 // 裏面」の結合文字列になっており、
 * 画像（表面のみ表示）とちぐはぐになるため、表面名だけを取り出す。
 */
export function resolveFrontFaceName(card: Pick<ScryfallCard, "name" | "card_faces">): string {
  return card.card_faces?.[0]?.name ?? card.name;
}

/** 両面カードの日本語名（printed_name）も各面にしかないため、表面のものを使う */
export function resolveFrontFacePrintedName(
  card: Pick<ScryfallCard, "printed_name" | "card_faces">,
): string | undefined {
  return card.card_faces?.[0]?.printed_name ?? card.printed_name;
}

/** タイプ行も両面カードはトップレベルが「表面 // 裏面」の結合表記になるため、表面のものを使う */
export function resolveFrontFaceTypeLine(
  card: Pick<ScryfallCard, "type_line" | "card_faces">,
): string | undefined {
  return card.card_faces?.[0]?.type_line ?? card.type_line;
}

/**
 * タイプ行の日本語訳（printed_type_line）は日本語版プリントの一部にしか無いため、
 * 無ければ呼び出し側で英語タイプ行にフォールバックする想定。
 */
export function resolveFrontFacePrintedTypeLine(
  card: Pick<ScryfallCard, "printed_type_line" | "card_faces">,
): string | undefined {
  return card.card_faces?.[0]?.printed_type_line ?? card.printed_type_line;
}

/** 両面カードは表裏それぞれのoracle_textを連結する（片面だけだと裏面の能力が読めなくなるため） */
export function resolveCombinedOracleText(
  card: Pick<ScryfallCard, "oracle_text" | "card_faces">,
): string | null {
  if (card.card_faces?.length) {
    const texts = card.card_faces.map((f) => f.oracle_text).filter(Boolean);
    return texts.length > 0 ? texts.join("\n//\n") : null;
  }
  return card.oracle_text ?? null;
}

/** ルールテキストの日本語訳（printed_text）。日本語版プリントの一部にしか無い */
export function resolveCombinedPrintedText(
  card: Pick<ScryfallCard, "printed_text" | "card_faces">,
): string | null {
  if (card.card_faces?.length) {
    const texts = card.card_faces.map((f) => f.printed_text).filter(Boolean);
    return texts.length > 0 ? texts.join("\n//\n") : null;
  }
  return card.printed_text ?? null;
}

export const RARITY_LABEL_JA: Record<string, string> = {
  common: "コモン",
  uncommon: "アンコモン",
  rare: "レア",
  mythic: "神話レア",
};

export async function fetchCardByFuzzyName(name: string): Promise<ScryfallCard | null> {
  const res = await fetch(`${SCRYFALL_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`, {
    headers: SCRYFALL_HEADERS,
    ...SCRYFALL_FETCH_OPTIONS,
  });
  if (!res.ok) return null;
  return res.json();
}

export async function fetchCardByScryfallId(scryfallId: string): Promise<ScryfallCard | null> {
  const res = await fetch(`${SCRYFALL_BASE}/cards/${scryfallId}`, {
    headers: SCRYFALL_HEADERS,
    ...SCRYFALL_FETCH_OPTIONS,
  });
  if (!res.ok) return null;
  return res.json();
}

/** Universes Beyond（コラボ作品）のプリントは、ルールテキスト中のカード名がフレーバー名に
 * 差し替わっていることがある（例: Final Fantasy版Ragavanの"Zidane Tribal"）。 */
export function isUniversesBeyondPrint(card: Pick<ScryfallCard, "promo_types">): boolean {
  return card.promo_types?.includes("universesbeyond") ?? false;
}

export async function fetchJapanesePrint(
  oracleName: string,
  opts?: { excludeUniversesBeyond?: boolean },
): Promise<ScryfallCard | null> {
  const query = encodeURIComponent(`!"${oracleName}" lang:ja`);
  const res = await fetch(`${SCRYFALL_BASE}/cards/search?q=${query}&unique=prints`, {
    headers: SCRYFALL_HEADERS,
    ...SCRYFALL_FETCH_OPTIONS,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: ScryfallCard[] };
  let prints: ScryfallCard[] = data.data ?? [];
  if (prints.length === 0) return null;
  if (opts?.excludeUniversesBeyond) {
    const nonUb = prints.filter((p) => !isUniversesBeyondPrint(p));
    if (nonUb.length > 0) prints = nonUb;
  }
  // printed_type_line が入っている版があればそれを優先する（無い版が先頭に来ることがあるため）
  return prints.find((p) => resolveFrontFacePrintedTypeLine(p)) ?? prints[0];
}

/** カード名: 日本語名があればそれをメイン表示、なければ英語名をそのままメイン表示 */
export function resolveDisplayName(card: { name: string; printed_name?: string }) {
  return {
    main: card.printed_name || card.name,
    sub: card.printed_name ? card.name : null,
  };
}
