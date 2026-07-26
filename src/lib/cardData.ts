import { supabase } from "./supabase";

export interface CardOracleRow {
  oracle_id: string;
  name: string;
  printed_name_ja: string | null;
  oracle_text: string | null;
}

export interface CardRow {
  scryfall_id: string;
  oracle_id: string;
  name: string;
  printed_name_ja: string | null;
  printed_text_ja: string | null;
  set_code: string;
  set_name: string;
  rarity: string;
  collector_number: string;
  lang: string;
  image_uri_normal: string | null;
  image_uri_art_crop: string | null;
  mana_cost: string | null;
  type_line: string | null;
  power: string | null;
  toughness: string | null;
  legalities: Record<string, string>;
}

export interface DbCardDetail {
  oracle: CardOracleRow;
  enCard: CardRow;
  jaCard: CardRow | null;
}

/**
 * card_oracles / cards（db/schema.sql）から代表プリント（英語）と日本語版プリントを取得する。
 * インポート済みのカードのみ見つかる（scripts/import-sample-cards.mjs 参照）。
 * 見つからない場合はnullを返す（呼び出し側でScryfallライブ取得にフォールバックする想定）。
 */
export async function getCardDetailFromDb(englishName: string): Promise<DbCardDetail | null> {
  const { data: oracle, error: oracleError } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja, oracle_text")
    .ilike("name", englishName)
    .maybeSingle();

  if (oracleError || !oracle) return null;

  const { data: cards, error: cardsError } = await supabase
    .from("cards")
    .select(
      "scryfall_id, oracle_id, name, printed_name_ja, printed_text_ja, set_code, set_name, rarity, collector_number, lang, image_uri_normal, image_uri_art_crop, mana_cost, type_line, power, toughness, legalities",
    )
    .eq("oracle_id", oracle.oracle_id);

  if (cardsError || !cards || cards.length === 0) return null;

  const enCard = cards.find((c) => c.lang === "en") ?? null;
  const jaCard = cards.find((c) => c.lang === "ja") ?? null;
  if (!enCard) return null;

  return { oracle, enCard, jaCard };
}

/**
 * oracle_id（UUID）から直接、代表プリント（英語）と日本語版プリントを取得する。
 * 実トーナメントデータ由来のカード（サンプルの22枚と違いスラグを持たない）用。
 */
export async function getCardDetailByOracleId(oracleId: string): Promise<DbCardDetail | null> {
  const { data: oracle, error: oracleError } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja, oracle_text")
    .eq("oracle_id", oracleId)
    .maybeSingle();

  if (oracleError || !oracle) return null;

  const { data: cards, error: cardsError } = await supabase
    .from("cards")
    .select(
      "scryfall_id, oracle_id, name, printed_name_ja, printed_text_ja, set_code, set_name, rarity, collector_number, lang, image_uri_normal, image_uri_art_crop, mana_cost, type_line, power, toughness, legalities",
    )
    .eq("oracle_id", oracle.oracle_id);

  if (cardsError || !cards || cards.length === 0) return null;

  const enCard = cards.find((c) => c.lang === "en") ?? null;
  const jaCard = cards.find((c) => c.lang === "ja") ?? null;
  if (!enCard) return null;

  return { oracle, enCard, jaCard };
}

/**
 * card_price_snapshots（db/schema.sql、scripts/snapshot-prices.mjsで日次投入）から
 * oracle_id + series の最新スナップショットを取得する。
 * まだ一度もスナップショットが取られていないカードはnullを返す（呼び出し側でライブ取得にフォールバック）。
 */
export async function getLatestPriceSnapshot(
  oracleId: string,
  series: "en" | "ja",
): Promise<{
  usd: number | null;
  jpyEst: number | null;
  usdFoil: number | null;
  jpyEstFoil: number | null;
} | null> {
  const { data, error } = await supabase
    .from("card_price_snapshots")
    .select("usd, jpy_est, usd_foil, jpy_est_foil")
    .eq("oracle_id", oracleId)
    .eq("series", series)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return { usd: data.usd, jpyEst: data.jpy_est, usdFoil: data.usd_foil, jpyEstFoil: data.jpy_est_foil };
}

/**
 * 英語名のリストから card_oracles.oracle_id を一括取得する（ランキング表示等での複数カード一括問い合わせ用）。
 * 見つからなかった名前はMapに含まれない。
 */
export async function getOracleIdsByNames(names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const { data, error } = await supabase.from("card_oracles").select("oracle_id, name").in("name", names);
  if (error || !data) return new Map();
  return new Map(data.map((row) => [row.name, row.oracle_id]));
}

/**
 * oracle_idのリストから、それぞれの最新の'en'系列スナップショット(jpy_est)を一括取得する。
 * 同一oracle_idに複数日分ある場合は最新日のものだけを採用する。
 */
export async function getJpyPricesByOracleIds(oracleIds: string[]): Promise<Map<string, number>> {
  if (oracleIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("card_price_snapshots")
    .select("oracle_id, jpy_est, date")
    .in("oracle_id", oracleIds)
    .eq("series", "en")
    .order("date", { ascending: false });
  if (error || !data) return new Map();

  const result = new Map<string, number>();
  for (const row of data) {
    if (!result.has(row.oracle_id) && row.jpy_est !== null) {
      result.set(row.oracle_id, row.jpy_est);
    }
  }
  return result;
}

/**
 * oracle_idのリストから、指定フォーマットの最新の採用率(usage_rate)を一括取得する（card_usage_stats）。
 * 同一oracle_id+formatに複数日分ある場合は最新日のものだけを採用する。
 */
export async function getUsageRatesByOracleIds(
  format: string,
  oracleIds: string[],
): Promise<Map<string, number>> {
  if (oracleIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("card_usage_stats")
    .select("oracle_id, usage_rate, calculated_at")
    .eq("format", format)
    .in("oracle_id", oracleIds)
    .order("calculated_at", { ascending: false });
  if (error || !data) return new Map();

  const result = new Map<string, number>();
  for (const row of data) {
    if (!result.has(row.oracle_id) && row.usage_rate !== null) {
      result.set(row.oracle_id, row.usage_rate);
    }
  }
  return result;
}

/** DBに保存済みのscryfall_idを使って現在価格だけをScryfallから取得する（軽量・IDピンポイント指定） */
export async function fetchPriceByScryfallId(
  scryfallId: string,
): Promise<{ usd: string | null } | null> {
  const res = await fetch(`https://api.scryfall.com/cards/${scryfallId}`, {
    headers: {
      "User-Agent": "jp-mtgstocks/0.1 (+https://github.com/jp-mtgstocks)",
      Accept: "application/json",
    },
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { usd: data.prices?.usd ?? null };
}
