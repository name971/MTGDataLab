import { supabase } from "./supabase";
import { getEarliestCardImages, getBestCardImages } from "./dbCardPrints";
import { getCatalogOraclesByNames } from "./catalogDb";
import { BANNED_CARDS, type BannedCardEntry } from "./bannedCards";
import { formatSlug, type Format } from "./formats";

export interface BannedCardWithCard extends Omit<BannedCardEntry, "imageUrl"> {
  oracleId: string;
  nameJa: string | null;
  imageUrl: string | null;
}

/**
 * 指定フォーマットの歴代禁止カードを、年ごとにグループ化して返す。
 * カード名からoracle_idを解決できなかったエントリ（DBの図鑑未反映等）は読み飛ばす。
 * カード画像は当時の雰囲気を出すため、最新プリントではなく初版（英語版）の画像を使う。
 *
 * @param sortDir "desc"（新しい年が先頭、デフォルト）| "asc"（古い年が先頭）
 * @param fillGaps trueの場合、収録データの最小〜最大年の間で禁止が無かった年も
 *   空のcards配列を持つ行として補完する（「禁止が無かった年」を空白行として強調したい用途）
 */
export async function getBannedCardsByYear(
  format: Format,
  { sortDir = "desc", fillGaps = false }: { sortDir?: "asc" | "desc"; fillGaps?: boolean } = {},
): Promise<{ year: number; cards: BannedCardWithCard[] }[]> {
  const entries = BANNED_CARDS.filter((e) => e.format === format);
  if (entries.length === 0) return [];

  const names = [...new Set(entries.map((e) => e.name))];
  const { data: oracles } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja")
    .in("name", names);
  const oracleByName = new Map((oracles ?? []).map((o) => [o.name, o]));

  // デッキ未使用のためPostgresから削除され、D1（カタログ専用）に移ったカードのフォールバック
  const missingNames = names.filter((n) => !oracleByName.has(n));
  if (missingNames.length > 0) {
    const catalogOracles = await getCatalogOraclesByNames(missingNames);
    for (const [name, row] of catalogOracles) {
      oracleByName.set(name, { oracle_id: row.oracle_id, name: row.name, printed_name_ja: row.printed_name_ja });
    }
  }

  const oracleIds = [...oracleByName.values()].map((o) => o.oracle_id);
  const imageByOracle = await getEarliestCardImages(oracleIds);

  const cards: BannedCardWithCard[] = [];
  for (const entry of entries) {
    const oracle = oracleByName.get(entry.name);
    if (!oracle) continue;
    cards.push({
      ...entry,
      oracleId: oracle.oracle_id,
      nameJa: oracle.printed_name_ja,
      imageUrl: entry.imageUrl ?? imageByOracle.get(oracle.oracle_id) ?? null,
    });
  }

  const byYear = new Map<number, BannedCardWithCard[]>();
  for (const card of cards) {
    if (!byYear.has(card.year)) byYear.set(card.year, []);
    byYear.get(card.year)!.push(card);
  }

  if (fillGaps) {
    const years = [...byYear.keys()];
    for (let y = Math.min(...years); y <= Math.max(...years); y++) {
      if (!byYear.has(y)) byYear.set(y, []);
    }
  }

  const rows = [...byYear.entries()].map(([year, cards]) => ({ year, cards }));
  rows.sort((a, b) => (sortDir === "asc" ? a.year - b.year : b.year - a.year));
  return rows;
}

export interface CurrentBannedCard {
  oracleId: string;
  nameJa: string | null;
  name: string;
  imageUrl: string | null;
  status: "banned" | "restricted";
}

/**
 * 「禁止カード」タブ用。歴代禁止カード（bannedCards.ts、手動更新のリスト）と違い、
 * こちらはScryfall由来のcards.legalities（日次バッチで更新される最新の合法性）を
 * そのまま見るため、後年に禁止解除されたカードは自動的に消える（歴代側は解除されても
 * 「その年に禁止された」という記録として残り続ける、という役割分担）。
 */
export async function getCurrentlyBannedCards(format: Format): Promise<CurrentBannedCard[]> {
  const key = formatSlug(format);
  const { data } = await supabase
    .from("cards")
    .select("oracle_id, name, legalities, card_oracles(printed_name_ja)")
    .eq("lang", "en")
    .or(`legalities->>${key}.eq.banned,legalities->>${key}.eq.restricted`);

  const byOracle = new Map<string, CurrentBannedCard>();
  for (const row of data ?? []) {
    if (byOracle.has(row.oracle_id)) continue; // 同じオラクルの複数プリントは1件にまとめる
    const legalities = row.legalities as Record<string, string> | null;
    const status = legalities?.[key] === "restricted" ? "restricted" : "banned";
    byOracle.set(row.oracle_id, {
      oracleId: row.oracle_id,
      // Supabase-jsの型はFK先を配列で推論するが実際は1件（多対1）
      nameJa: (row.card_oracles as unknown as { printed_name_ja: string | null } | null)?.printed_name_ja ?? null,
      name: row.name,
      imageUrl: null,
      status,
    });
  }

  const oracleIds = [...byOracle.keys()];
  const imageByOracle = await getBestCardImages(oracleIds);
  for (const [oracleId, card] of byOracle) {
    card.imageUrl = imageByOracle.get(oracleId) ?? null;
  }

  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface ReservedListCard {
  oracleId: string;
  nameJa: string | null;
  name: string;
  imageUrl: string | null;
  priceJpy: number | null;
}

/** 「再録禁止カード」タブ用。card_oracles.is_reservedはimport-deck-cards.mjs等が
 * Scryfallバルクデータの各プリントから拾って埋めている（1プリントでもreserved=trueなら
 * そのオラクルはリザーブドリスト対象、db/schema.sql参照）。
 * リザーブドリストのカードは現行フォーマットのデッキで使われないものが大半で、
 * card_current_prices（デッキ使用実績があるカード中心にキャッシュされる、
 * dbTrendingCards.ts等参照）にほぼ載っていないため、代わりにcard_print_current_prices
 * （Scryfallバルクの日次スナップショット、全カード対象）から最安値を拾う。 */
export async function getReservedListCards(): Promise<ReservedListCard[]> {
  const { data: oracles } = await supabase
    .from("card_oracles")
    .select("oracle_id, name, printed_name_ja")
    .eq("is_reserved", true);
  if (!oracles || oracles.length === 0) return [];

  const oracleIds = oracles.map((o) => o.oracle_id);
  // リザーブドリストは571件（2026-08時点）あり、.in()に全件のoracle_idを1回のURLに
  // 乗せるとリクエストURLが16KBを超えてSupabase/undici側でエラーになる（実際に発生・
  // HeadersOverflowError、2026-08-30発覚）。他のスクリプトのDECK_ID_CHUNK等と同じく
  // チャンクに分けて複数回に分けて投げる。
  const ORACLE_ID_CHUNK = 150;
  const priceRows: { oracle_id: string; usd: number | null; usd_foil: number | null }[] = [];
  for (let i = 0; i < oracleIds.length; i += ORACLE_ID_CHUNK) {
    const chunk = oracleIds.slice(i, i + ORACLE_ID_CHUNK);
    const { data } = await supabase
      .from("card_print_current_prices")
      .select("oracle_id, usd, usd_foil")
      .in("oracle_id", chunk);
    if (data) priceRows.push(...data);
  }
  const [imageByOracle, { data: fxRows }] = await Promise.all([
    getBestCardImages(oracleIds),
    supabase.from("exchange_rates").select("usd_to_jpy").order("date", { ascending: false }).limit(1),
  ]);
  const usdToJpy = fxRows?.[0]?.usd_to_jpy != null ? Number(fxRows[0].usd_to_jpy) : 150;

  const cheapestUsdByOracle = new Map<string, number>();
  for (const p of priceRows ?? []) {
    const candidates = [p.usd, p.usd_foil].filter((v): v is number => v != null).map(Number);
    if (candidates.length === 0) continue;
    const cheapest = Math.min(...candidates);
    const existing = cheapestUsdByOracle.get(p.oracle_id);
    if (existing == null || cheapest < existing) cheapestUsdByOracle.set(p.oracle_id, cheapest);
  }

  return oracles
    .map((o) => {
      const usd = cheapestUsdByOracle.get(o.oracle_id);
      return {
        oracleId: o.oracle_id,
        nameJa: o.printed_name_ja,
        name: o.name,
        imageUrl: imageByOracle.get(o.oracle_id) ?? null,
        priceJpy: usd != null ? Math.round(usd * usdToJpy) : null,
      } satisfies ReservedListCard;
    })
    .sort((a, b) => (b.priceJpy ?? -1) - (a.priceJpy ?? -1));
}
