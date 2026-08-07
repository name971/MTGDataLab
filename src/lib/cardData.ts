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
  printed_type_line: string | null;
  power: string | null;
  toughness: string | null;
  legalities: Record<string, string>;
  is_universes_beyond: boolean;
}

export interface DbCardDetail {
  oracle: CardOracleRow;
  enCard: CardRow;
  jaCard: CardRow | null;
  /**
   * 代表プリント（最安値優先で選ぶ）のjaCardは、Scryfall側にそもそもprinted_type_lineが
   * 無いプリント（マスターピース等の特殊枠）のことがある（例: Ragavan, Nimble Pilfererの
   * Final Fantasy: Through the Ages版）。printed_nameが既に別プリントからのフォールバックに
   * 対応しているのと同様に、同じoracleの他のja版プリントにprinted_type_lineがあればそれを使う。
   */
  fallbackTypeLineJa: string | null;
  /**
   * 代表プリント（jaCard）がUniverses Beyond（コラボ作品）のプリントだと、ルールテキスト中の
   * カード名がフレーバー名に差し替わっていることがある（例: Final Fantasy版Ragavanの
   * "ジタン・トライバル"）。他のプリント（その他のプリント欄を含む）を見た際に混乱を招くため、
   * 代表プリント自体がUB版の場合は非コラボ版のテキストを優先して使う。
   */
  fallbackTextJa: string | null;
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
      "scryfall_id, oracle_id, name, printed_name_ja, printed_text_ja, set_code, set_name, rarity, collector_number, lang, image_uri_normal, image_uri_art_crop, mana_cost, type_line, printed_type_line, power, toughness, legalities, is_universes_beyond",
    )
    .eq("oracle_id", oracle.oracle_id);

  if (cardsError || !cards || cards.length === 0) return null;

  const enCard = cards.find((c) => c.lang === "en") ?? null;
  const jaCard = cards.find((c) => c.lang === "ja") ?? null;
  if (!enCard) return null;

  const [fallbackTypeLineJa, fallbackTextJa] = await Promise.all([
    resolveFallbackTypeLineJa(enCard, jaCard),
    resolveFallbackTextJa(oracle.oracle_id, jaCard),
  ]);
  return { oracle, enCard, jaCard, fallbackTypeLineJa, fallbackTextJa };
}

/**
 * 代表プリント（jaCard）がタイプ行未翻訳（Scryfall側にそもそも無い、マスターピース等の
 * 特殊枠プリントで起きる）の場合、同じオラクルの別の日本語プリントをDBから探して補完する
 * （自前のcardsテーブルだけで完結させ、Scryfallへのライブ問い合わせは行わない）。
 * printed_name/printed_textと違い、タイプ行はプリントによってフレーバー変更されない
 * （クリーチャータイプ自体はゲームルール上の分類のため）ので、他プリントからの流用が安全。
 * DBに他のja版プリントが1件も無い場合はnullのまま（英語のtype_lineにフォールバックする）。
 */
async function resolveFallbackTypeLineJa(enCard: CardRow, jaCard: CardRow | null): Promise<string | null> {
  if (!jaCard || jaCard.printed_type_line) return null;
  const { data } = await supabase
    .from("cards")
    .select("printed_type_line")
    .eq("oracle_id", enCard.oracle_id)
    .eq("lang", "ja")
    .not("printed_type_line", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.printed_type_line ?? null;
}

/**
 * 代表プリント自体がUniverses Beyond（コラボ作品）のプリントで、ルールテキスト中の
 * カード名がフレーバー名に差し替わっている場合、非コラボ版のテキストで上書きする。
 * is_universes_beyond（インポート時にScryfallのpromo_typesから判定・保存済み）を見るだけなので
 * ライブ問い合わせは不要。代表プリントが元々UB版でなければ何もしない（null）。
 * 非コラボ版のja訳もDBに無い場合はnullのまま（コラボ版のテキストがそのまま表示される）。
 */
async function resolveFallbackTextJa(oracleId: string, jaCard: CardRow | null): Promise<string | null> {
  if (!jaCard?.printed_text_ja || !jaCard.is_universes_beyond) return null;
  const { data } = await supabase
    .from("cards")
    .select("printed_text_ja")
    .eq("oracle_id", oracleId)
    .eq("lang", "ja")
    .eq("is_universes_beyond", false)
    .not("printed_text_ja", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.printed_text_ja ?? null;
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
      "scryfall_id, oracle_id, name, printed_name_ja, printed_text_ja, set_code, set_name, rarity, collector_number, lang, image_uri_normal, image_uri_art_crop, mana_cost, type_line, printed_type_line, power, toughness, legalities, is_universes_beyond",
    )
    .eq("oracle_id", oracle.oracle_id);

  if (cardsError || !cards || cards.length === 0) return null;

  const enCard = cards.find((c) => c.lang === "en") ?? null;
  const jaCard = cards.find((c) => c.lang === "ja") ?? null;
  if (!enCard) return null;

  const [fallbackTypeLineJa, fallbackTextJa] = await Promise.all([
    resolveFallbackTypeLineJa(enCard, jaCard),
    resolveFallbackTextJa(oracle.oracle_id, jaCard),
  ]);
  return { oracle, enCard, jaCard, fallbackTypeLineJa, fallbackTextJa };
}

/**
 * exchange_rates（db/schema.sql、日次バッチで投入）の最新日のUSD/JPYレートを取得する。
 * 新規インポートしたばかりでcard_cheapest_price_snapshotsがまだ無い（＝jpy_estが無い）
 * カードの円価格を、前日までの直近レートで仮計算するために使う。外部為替APIを毎回
 * ライブで叩くのは処理が重いため避け、既にDBにある値だけで済ませる。
 */
export async function getLatestUsdToJpyRate(): Promise<number | null> {
  const { data, error } = await supabase
    .from("exchange_rates")
    .select("usd_to_jpy")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return Number(data.usd_to_jpy);
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
 * oracle_idのリストから、それぞれの最新の「全プリント中最安値」(jpy_est)を一括取得する。
 * 同一oracle_idに複数日分ある場合は最新日のものだけを採用する。
 * card_price_snapshots（代表プリントのみ）ではなく、カード詳細ページと同じ基準
 * （card_cheapest_price_snapshots、全プリント横断の最安値）を使う。
 */
export async function getJpyPricesByOracleIds(oracleIds: string[]): Promise<Map<string, number>> {
  if (oracleIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("card_current_prices")
    .select("oracle_id, jpy_est")
    .in("oracle_id", oracleIds);
  if (error || !data) return new Map();

  const result = new Map<string, number>();
  for (const row of data) {
    if (row.jpy_est !== null) result.set(row.oracle_id, row.jpy_est);
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

/**
 * card_print_prices（プリント単位の日次価格履歴、日次バッチで先に埋まっていることが多い）から、
 * そのプリントの最新日のUSD価格を取得する。card_cheapest_price_snapshotsが未生成の
 * 新規カードでも、こちらは既にデータがあることが多いため、ライブ取得より先にこちらを試す。
 */
export async function getLatestPrintUsd(scryfallId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("card_print_prices")
    .select("prices")
    .eq("scryfall_id", scryfallId)
    .maybeSingle();
  if (error || !data) return null;
  const usdByDate = (data.prices ?? {}) as Record<string, number>;
  const dates = Object.keys(usdByDate).sort();
  const lastDate = dates.at(-1);
  return lastDate !== undefined ? usdByDate[lastDate] : null;
}

/**
 * DBに保存済みのscryfall_idを使って現在価格だけをScryfallから取得する（軽量・IDピンポイント指定）。
 * card_print_pricesにも無い、真に新規のプリント（どの日次バッチにもまだ触れられていない）の
 * 最終手段としてのみ呼ばれる想定。
 */
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
