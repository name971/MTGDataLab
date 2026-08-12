import { supabase } from "./supabase";
import { getLatestPricesForPrints } from "./dbCardPrintPrices";

export interface CardPrint {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string | null;
  imageUrl: string | null;
  /** 金縁(World Championship Decks等)・銀縁(Un-set)・memorabilia区分など、
   * オラクルとしては合法でもこの物理プリント自体はどのフォーマットでも使用不可 */
  notTournamentLegal: boolean;
  /** このプリント固有のレアリティ（common/uncommon/rare/mythic）。再録時に変わることがあるため
   * プリントごとに持つ。scripts/rebuild-card-prints.mjs未反映の古い行はnullのことがある */
  rarity: string | null;
}

interface CardPrintRow {
  scryfall_id: string;
  set_code: string;
  sets: { set_name: string } | null;
  collector_number: string;
  released_at: string | null;
  image_uri_normal: string | null;
  image_uri_normal_ja: string | null;
  not_tournament_legal: boolean;
  rarity: string | null;
}

function toCardPrint(p: CardPrintRow): CardPrint {
  return {
    scryfallId: p.scryfall_id,
    setCode: p.set_code,
    setName: p.sets?.set_name ?? p.set_code,
    collectorNumber: p.collector_number,
    releasedAt: p.released_at,
    // 日本語版の画像があればそちらを優先する（無ければ英語版）
    imageUrl: p.image_uri_normal_ja ?? p.image_uri_normal,
    notTournamentLegal: p.not_tournament_legal,
    rarity: p.rarity,
  };
}

const CARD_PRINT_SELECT =
  "scryfall_id, set_code, sets(set_name), collector_number, released_at, image_uri_normal, image_uri_normal_ja, not_tournament_legal, rarity";

// 基本土地等は700件超のプリントを持ち、egress（プリント一覧＋各プリントの価格取得）を
// 突出して消費する。ページ最初の読み込みでは新しい版から直近OTHER_PRINTS_PAGE_SIZE件だけを
// 取得し、残りは「もっと見る」操作時にAPI経由（/api/other-prints）で追加取得する。
// 上限は設けない（全件見られる）が、1リクエストあたりの取得量は常に一定に抑えられる。
export const OTHER_PRINTS_PAGE_SIZE = 100;

export interface CardPrintsPage {
  prints: CardPrint[];
  /** card_prints全体の件数（表示中の件数ではなく、そのオラクルの全プリント数）。
   * 「全X種のプリント」表示用。count自体は行データを返さないので取得コストが小さい。 */
  totalCount: number;
}

/**
 * card_prints（scripts/rebuild-card-prints.mjsがScryfallバルクデータから事前生成、db/schema.sql参照）
 * からカード詳細ページ「その他のプリント」欄用の一覧を取得する。ライブAPI呼び出しはしない。
 * set_nameは正規化されたsetsテーブルから結合して取得する（容量削減、db/schema.sql参照）。
 * offset〜offset+limit-1件だけを返す（ページング、egress対策）。sortBy="price"の場合は、
 * card_print_current_prices（1プリント1行、scryfall_idがPKでcard_printsと1:1）をDB側で
 * 結合して並び替える。「もっと見る」でページを跨いでも常に正しい順序になるよう、
 * クライアント側で読み込み済み分だけをソートするのではなくDB側でソート済みのページを返す方式にした。
 */
export async function getOtherPrintsForCard(
  oracleId: string,
  offset = 0,
  limit: number = OTHER_PRINTS_PAGE_SIZE,
  sortBy: "releaseDate" | "price" = "releaseDate",
  sortDir: "asc" | "desc" = "desc",
  finish: "normal" | "foil" = "normal",
): Promise<CardPrintsPage> {
  const priceColumn = finish === "foil" ? "usd_foil" : "usd";
  let query = supabase
    .from("card_prints")
    .select(`${CARD_PRINT_SELECT}, card_print_current_prices(${priceColumn})`)
    .eq("oracle_id", oracleId);
  // supabase-jsの.order(column, { foreignTable })は「埋め込み配列内の行」を並べる構文
  // （1対多向け）で、今回のような「埋め込みリソースの列でトップレベル行を並べる」（1対1）
  // ケースには効かない（並び順が反映されず黙って無視される）。PostgRESTのorder=table(col).dir
  // 構文をそのままcolumn名として渡す必要がある。
  query =
    sortBy === "price"
      ? query.order(`card_print_current_prices(${priceColumn})` as "id", {
          ascending: sortDir === "asc",
          nullsFirst: false, // 価格不明は常に末尾（昇順・降順どちらでも）
        })
      : query.order("released_at", { ascending: sortDir === "asc" });

  const [{ data, error }, { count }] = await Promise.all([
    query.range(offset, offset + limit - 1).returns<CardPrintRow[]>(),
    supabase
      .from("card_prints")
      .select("scryfall_id", { count: "exact", head: true })
      .eq("oracle_id", oracleId),
  ]);
  if (error) return { prints: [], totalCount: count ?? 0 };

  return { prints: (data ?? []).map(toCardPrint), totalCount: count ?? 0 };
}

/**
 * 「カードデータ」欄のメイン画像を選ぶ。トーナメント使用可能な全プリントを価格が安い順に見ていき、
 * その版に一致する日本語版画像（image_uri_normal_ja）があれば採用する。無ければ次に安いプリントで
 * 同じ判定を繰り返し、どのプリントにも日本語版が無ければ一番安いプリントの英語版画像を使う。
 * card_printsに行が無い（scripts/rebuild-card-prints.mjs未反映）オラクルはnullを返す
 * （呼び出し側でcardsテーブルの代表プリント画像にフォールバックする想定）。
 */
export async function getBestCardImage(oracleId: string): Promise<string | null> {
  const PAGE_SIZE = 1000;
  const rows: { scryfall_id: string; image_uri_normal: string | null; image_uri_normal_ja: string | null }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("card_prints")
      .select("scryfall_id, image_uri_normal, image_uri_normal_ja")
      .eq("oracle_id", oracleId)
      .eq("not_tournament_legal", false)
      // 順序が不定だと、価格がどのプリントにも無い場合のフォールバック（rows[0]）が呼び出しごとに
      // ばらつき、「カードデータ」とデッキ詳細で表示される画像が食い違う原因になるため固定する
      .order("scryfall_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return null;
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  if (rows.length === 0) return null;

  const prices = await getLatestPricesForPrints(rows.map((r) => r.scryfall_id));
  // 「安い順」の判定には通常価格を優先しつつ、通常価格が無いFoil専用プリント（Secret Lair等）も
  // Foil価格で価格ありとして扱う。通常価格だけを見ていると、Foil専用カードは全プリントが
  // 「価格不明」扱いになってJA画像チェックが素通りされ、日本語版があっても英語版画像に
  // フォールバックしてしまっていた。
  const priceOf = (scryfallId: string) => prices.normal.get(scryfallId) ?? prices.foil.get(scryfallId);
  const priced = rows
    .filter((r) => priceOf(r.scryfall_id) !== undefined)
    .sort((a, b) => priceOf(a.scryfall_id)! - priceOf(b.scryfall_id)!);

  for (const r of priced) {
    if (r.image_uri_normal_ja) return r.image_uri_normal_ja;
  }
  // どのプリントにも日本語版画像が無ければ、一番安いプリント（価格不明な行しか無ければ先頭の行）の英語版画像を使う
  return (priced[0] ?? rows[0]).image_uri_normal ?? null;
}

const ORACLE_ID_CHUNK = 150; // .in()にUUIDを大量に並べるとURLが長すぎてPostgRESTが400を返すため

/**
 * getBestCardImageの複数オラクル一括版。ランキング・注目カード等の一覧ページ用に、
 * オラクルの件数に関わらず一定回数のクエリで済ませる（1件ずつ問い合わせるN+1を避ける）。
 * 選定ロジックはgetBestCardImageと同じ（安い順に見て日本語版画像がある最初の1枚を採用）。
 * 画像が決まらなかったオラクルはMapに含めない（呼び出し側でcardsテーブルの代表プリント画像に
 * フォールバックする想定）。
 */
export async function getBestCardImages(oracleIds: string[]): Promise<Map<string, string>> {
  if (oracleIds.length === 0) return new Map();

  const rows: {
    oracle_id: string;
    scryfall_id: string;
    image_uri_normal: string | null;
    image_uri_normal_ja: string | null;
  }[] = [];
  const PAGE_SIZE = 1000;
  for (let i = 0; i < oracleIds.length; i += ORACLE_ID_CHUNK) {
    const chunk = oracleIds.slice(i, i + ORACLE_ID_CHUNK);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: page, error } = await supabase
        .from("card_prints")
        .select("oracle_id, scryfall_id, image_uri_normal, image_uri_normal_ja")
        .in("oracle_id", chunk)
        .eq("not_tournament_legal", false)
        // getBestCardImageと同様、価格がどのプリントにも無い場合のフォールバック（group[0]）が
        // 呼び出しごとにばらつかないよう固定する
        .order("scryfall_id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) break;
      if (!page || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  if (rows.length === 0) return new Map();

  const prices = await getLatestPricesForPrints(rows.map((r) => r.scryfall_id));

  const rowsByOracle = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!rowsByOracle.has(r.oracle_id)) rowsByOracle.set(r.oracle_id, []);
    rowsByOracle.get(r.oracle_id)!.push(r);
  }

  // getBestCardImageと同じ理由で、通常価格が無いFoil専用プリントもFoil価格で「価格あり」として扱う
  const priceOf = (scryfallId: string) => prices.normal.get(scryfallId) ?? prices.foil.get(scryfallId);

  const result = new Map<string, string>();
  for (const [oracleId, group] of rowsByOracle) {
    const priced = group
      .filter((r) => priceOf(r.scryfall_id) !== undefined)
      .sort((a, b) => priceOf(a.scryfall_id)! - priceOf(b.scryfall_id)!);

    const jaHit = priced.find((r) => r.image_uri_normal_ja);
    const imageUrl = jaHit?.image_uri_normal_ja ?? (priced[0] ?? group[0]).image_uri_normal;
    if (imageUrl) result.set(oracleId, imageUrl);
  }
  return result;
}

/**
 * getBestCardImagesの初版版。歴代禁止カード等、当時の雰囲気を出すために一番古いプリント
 * （英語版）の画像を使いたい場合向け。価格は見ず、released_atが最も古い行の
 * image_uri_normalを採用する（日本語版は当時存在しないことが多いため英語版のみ）。
 */
export async function getEarliestCardImages(oracleIds: string[]): Promise<Map<string, string>> {
  if (oracleIds.length === 0) return new Map();

  const rows: { oracle_id: string; released_at: string | null; image_uri_normal: string | null }[] = [];
  const PAGE_SIZE = 1000;
  for (let i = 0; i < oracleIds.length; i += ORACLE_ID_CHUNK) {
    const chunk = oracleIds.slice(i, i + ORACLE_ID_CHUNK);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data: page, error } = await supabase
        .from("card_prints")
        .select("oracle_id, released_at, image_uri_normal")
        .in("oracle_id", chunk)
        .not("image_uri_normal", "is", null)
        .order("released_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) break;
      if (!page || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }

  const result = new Map<string, string>();
  for (const r of rows) {
    // released_at昇順で取得しているので、oracleIdごとに最初に出てきた行が最古のプリント
    if (!result.has(r.oracle_id) && r.image_uri_normal) result.set(r.oracle_id, r.image_uri_normal);
  }
  return result;
}

/** プリント別詳細ページ（/cards/[oracleId]/prints/[scryfallId]）用に1件だけ取得する */
export async function getCardPrintByScryfallId(scryfallId: string): Promise<CardPrint | null> {
  const { data, error } = await supabase
    .from("card_prints")
    .select(CARD_PRINT_SELECT)
    .eq("scryfall_id", scryfallId)
    .maybeSingle()
    .returns<CardPrintRow>();
  if (error || !data) return null;

  return toCardPrint(data);
}

/**
 * セットシンボル画像URL（sets.icon_svg_uri、db/schema.sql参照）をset_code単位で一括取得する。
 * `https://svgs.scryfall.io/sets/<set_code>.svg`という命名規則は一部の特殊セット
 * （Secret Lair Drop=sld→star.svg等）では成り立たないため、Scryfallの/setsから同期した
 * 正しいURLをこちらで持つ（scripts/backfill-set-icons.mjs）。無い場合はnullを返す
 * （呼び出し側で従来の命名規則によるフォールバックURLを使う）。
 */
export async function getIconUrlBySetCodes(setCodes: string[]): Promise<Record<string, string>> {
  const uniqueCodes = [...new Set(setCodes)];
  if (uniqueCodes.length === 0) return {};
  const { data } = await supabase.from("sets").select("set_code, icon_svg_uri").in("set_code", uniqueCodes);
  const result: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.icon_svg_uri) result[row.set_code] = row.icon_svg_uri;
  }
  return result;
}
