import { supabase } from "./supabase";
import { colorsFromManaCost } from "./manaColors";
import { getJpyPricesByOracleIds } from "./cardData";
import { getRecentPriceHistoryForOracles } from "./priceArchiveDb";
import { getR2RecentPriceChanges } from "./priceArchiveR2";
import type { Format } from "./formats";
import { formatSlug } from "./formats";
import { TYPE_GLOSSARY_JA_TO_EN } from "./typeGlossary";

export interface AdvancedSearchFilters {
  name?: string;
  text?: string;
  /** タイプ行クイック選択（複数選択可、AND。例:「クリーチャー」+「エンチャント」でエンチャント・クリーチャーを絞る） */
  types?: string[];
  /** タイプ行の手入力欄（クイック選択と併用でき、こちらもANDで効く） */
  typeText?: string;
  colors?: string[]; // W/U/B/R/Gのサブセット。「これらの色を全て含む」で判定する
  colorlessOnly?: boolean;
  rarities?: string[]; // common/uncommon/rare/mythic
  /** フォーマット適正（複数選択可、OR。いずれかのフォーマットで合法なら該当） */
  formats?: Format[];
  /** マナ総量（マナカーブと同じ"0"〜"6"・"7+"表記、複数選択可・OR。"7+"は7以上） */
  mvBuckets?: string[];
  priceMin?: number;
  priceMax?: number;
  /** 採用率(%)フィルタ。formatsが複数ある場合は先頭の1つだけを対象にする（採用率はフォーマット単位の値のため）。
   * formats未指定時は無視する */
  usageRateMin?: number;
  usageRateMax?: number;
  usagePeriodDays?: 7 | 30 | 90;
  /** 価格変化率(%)フィルタ。指定期間前との比較（マイナス=値下がりも指定可） */
  priceChangeMin?: number;
  priceChangeMax?: number;
  priceChangePeriodDays?: 7 | 30 | 90;
  sortKey?: "price" | "releasedAt";
  sortDir?: "asc" | "desc";
}

export interface AdvancedSearchResult {
  oracleId: string;
  nameEn: string;
  nameJa: string | null;
  imageUrl: string | null;
  typeLine: string | null;
  rarity: string;
  priceJpy: number | null;
}

interface CardRow {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  power: string | null;
  toughness: string | null;
  rarity: string;
  legalities: Record<string, string>;
  image_uri_normal: string | null;
  /** 代表プリント（lang='en'）の発売日。登録日順ソート用の目安（再録の代表行だと初出より新しい日付になりうる） */
  released_at: string | null;
}

const CARD_SELECT =
  "oracle_id, name, mana_cost, type_line, power, toughness, rarity, legalities, image_uri_normal, released_at";

// 候補が多すぎるとフィルタ処理・後続の価格問い合わせが重くなるため、SQL側の絞り込み後の
// 候補数に上限を設ける（色・マナ総量・価格帯・価格変化率はここではなくJS側で判定するため、
// SQLだけでは絞り切れないことがある）。
const CANDIDATE_CAP = 500;
// 1回の応答件数（初回表示・もっと見る共通）。全件はCANDIDATE_CAPまでで、残りは
// もっと見るボタン（/api/advanced-search）でこの単位ずつ追加取得する。
export const PAGE_SIZE = 60;
// .in()にUUIDを一度に大量に並べるとURLが長すぎてPostgRESTが400 Bad Requestを返す
// （dbCardPrintPrices.ts等、他所で実際に踏んだのと同じ問題）。チャンクに分割して問い合わせる。
const ID_CHUNK = 150;
// oracle_text・printed_text_ja等のILIKE検索でヒットするoracle_id候補自体も、ありふれた単語
// （例:「引く」）だとPostgRESTのデフォルト行数上限（1000件）に達することがある。以降どうせ
// CANDIDATE_CAP件しか使わないため、候補集めの上限もそれに合わせて確保しておけば十分。
const ID_LOOKUP_LIMIT = CANDIDATE_CAP * 2;

// マナ総量は以前は"{2}{W/U}{B}"のようなmana_costをJS側でパースして判定していたが、
// cards.mana_value（生成列、db/schema.sql参照。同じロジックのSQL関数mana_value_from_costで
// mana_costから計算・インデックス済み）に切り替えたため、JS側の計算は不要になった。
export const MV_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"] as const;

// ルール変更でカード・タイプ名が変わったが、古いプリントのtype_lineには旧名称のまま残っているもの。
// 例: 同族(Kindred)は元々「部族」(Tribal)、インスタント(Instant)は「インターラプト」(Interrupt)を
// 統合した経緯があり、ごく一部の古いカードのtype_lineには今も旧名称が残っている。
const LEGACY_TYPE_ALIASES: Record<string, string[]> = {
  同族: ["Tribal"],
  インスタント: ["Interrupt"],
};

/**
 * タイプ行の検索語（例:「マーフォーク」）に対応する英語のクリーチャー・タイプ等を辞書から探す。
 * 日本語版プリントが1件も無いカード（type_lineが常に英語のまま）でも、この英語訳で
 * type_line.ilikeにヒットさせられる。複数のタイプ名を含む入力（例:「エルフ・戦士」）にも
 * 対応するため、辞書のキーが入力に部分一致するもの全てを集める。
 */
function englishTypeEquivalents(input: string): string[] {
  const matches: string[] = [];
  for (const [ja, en] of Object.entries(TYPE_GLOSSARY_JA_TO_EN)) {
    if (input.includes(ja)) {
      matches.push(en);
      if (LEGACY_TYPE_ALIASES[ja]) matches.push(...LEGACY_TYPE_ALIASES[ja]);
    }
  }
  return matches;
}

function hasAnyFilter(f: AdvancedSearchFilters): boolean {
  return !!(
    f.name?.trim() ||
    f.text?.trim() ||
    (f.types && f.types.length > 0) ||
    f.typeText?.trim() ||
    (f.colors && f.colors.length > 0) ||
    f.colorlessOnly ||
    (f.rarities && f.rarities.length > 0) ||
    (f.formats && f.formats.length > 0) ||
    (f.mvBuckets && f.mvBuckets.length > 0) ||
    f.priceMin !== undefined ||
    f.priceMax !== undefined ||
    f.usageRateMin !== undefined ||
    f.usageRateMax !== undefined ||
    f.priceChangeMin !== undefined ||
    f.priceChangeMax !== undefined
  );
}

/** 複数指定できるタイプ行キーワード（クイック選択＋手入力欄）ごとに、英語/日本語両対応でoracle_idを絞り込むための
 * OR条件（type_line ilike 英語表記いずれか or 日本語版type_lineに一致するoracle_id）を1キーワードにつき1つ作る。
 * 呼び出し側でキーワードごとに.or()をチェーンすることで、キーワード間はAND（全キーワードを満たす）になる。
 */
async function buildTypeOrClause(keyword: string): Promise<string> {
  const { data } = await supabase
    .from("cards")
    .select("oracle_id")
    .eq("lang", "ja")
    .ilike("printed_type_line", `%${keyword}%`)
    .limit(ID_LOOKUP_LIMIT);
  const jaOracleIds = (data ?? []).map((r) => r.oracle_id);
  const enEquivalents = englishTypeEquivalents(keyword);

  const orParts = [`type_line.ilike.%${keyword}%`, ...enEquivalents.map((en) => `type_line.ilike.%${en}%`)];
  if (jaOracleIds.length > 0) orParts.push(`oracle_id.in.(${jaOracleIds.slice(0, ID_CHUNK).join(",")})`);
  return orParts.join(",");
}

export interface AdvancedSearchPage {
  results: AdvancedSearchResult[];
  /** SQL・JS側の全フィルタを適用した後の該当件数（表示件数ではなく実際の総件数）。
   * CANDIDATE_CAP（500）が実質的な上限になる。もっと見るボタンの残り件数表示に使う。 */
  totalCount: number;
  /** trueの場合、CANDIDATE_CAPに達したため走査を打ち切っており、totalCountは
   * 実際の該当件数の下限（＝本当はもっとある）。呼び出し側で「N件以上」と表示する想定。 */
  capped: boolean;
}

/**
 * Scryfallの高度検索（https://scryfall.com/advanced）を参考にした複合条件検索。
 * SQL側で絞り込める条件（名前・ルールテキスト・タイプ行・レアリティ・フォーマット適正・採用率）を
 * 先にDBへ問い合わせて候補を絞り、DBに列を持たない条件（色・マナ総量・価格帯）や、D1側の
 * 履歴データが必要な条件（価格変化率）はJS側で候補を絞ってから判定する。
 * 条件を1つも指定していない場合は全件スキャンを避けるため空配列を返す。
 * offset/limitは絞り込み済みの並び順（価格降順）に対するページングで、もっと見るボタン
 * （/api/advanced-search）から続きを取得する時に使う。
 */
export async function advancedSearchCards(
  filters: AdvancedSearchFilters,
  offset = 0,
  limit: number = PAGE_SIZE,
): Promise<AdvancedSearchPage> {
  if (!hasAnyFilter(filters)) return { results: [], totalCount: 0, capped: false };

  const name = filters.name?.trim();
  const text = filters.text?.trim();
  const typeKeywords = [...(filters.types ?? []), ...(filters.typeText?.trim() ? [filters.typeText.trim()] : [])];

  // 日本語名はcard_oraclesにしか無いため、cards.name（英語）とのOR条件用に別途oracle_idを引く
  let jaNameOracleIds: string[] = [];
  if (name) {
    const { data } = await supabase
      .from("card_oracles")
      .select("oracle_id")
      .ilike("printed_name_ja", `%${name}%`)
      .limit(ID_LOOKUP_LIMIT);
    jaNameOracleIds = (data ?? []).map((r) => r.oracle_id);
  }

  const typeOrClauses = await Promise.all(typeKeywords.map(buildTypeOrClause));

  // ルールテキストは英語がcard_oracles.oracle_text、日本語訳がcards（lang='ja'）のprinted_text_ja
  // に分かれているため、両方でヒットしたoracle_idを合算する。ありふれた単語だと候補が数千件に
  // 及ぶことがあるため、それぞれ上限を設けてから合算する。
  let textOracleIds: string[] | null = null;
  if (text) {
    const [{ data: enTextRows }, { data: jaTextRows }] = await Promise.all([
      supabase.from("card_oracles").select("oracle_id").ilike("oracle_text", `%${text}%`).limit(ID_LOOKUP_LIMIT),
      supabase
        .from("cards")
        .select("oracle_id")
        .eq("lang", "ja")
        .ilike("printed_text_ja", `%${text}%`)
        .limit(ID_LOOKUP_LIMIT),
    ]);
    textOracleIds = [
      ...new Set([...(enTextRows ?? []).map((r) => r.oracle_id), ...(jaTextRows ?? []).map((r) => r.oracle_id)]),
    ];
    if (textOracleIds.length === 0) return { results: [], totalCount: 0, capped: false }; // ルールテキストに一致するカードが無ければこの時点で確定
  }

  // 採用率フィルタはフォーマット指定が無いと判定しようがないため、formats未指定時は無視する。
  // 複数フォーマットが選ばれている場合は先頭の1つだけを対象にする（採用率はフォーマット単位の値のため）。
  // card_usage_statsから該当フォーマット・期間の最新日の行を絞り込み、oracle_id候補にする。
  const usageFormat = filters.formats?.[0];
  let usageOracleIds: string[] | null = null;
  if (usageFormat && (filters.usageRateMin !== undefined || filters.usageRateMax !== undefined)) {
    const periodDays = filters.usagePeriodDays ?? 30;
    const { data: latestRow } = await supabase
      .from("card_usage_stats")
      .select("calculated_at")
      .eq("format", usageFormat)
      .eq("period_days", periodDays)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestRow) return { results: [], totalCount: 0, capped: false }; // このフォーマット・期間の採用率データが無ければ確定で0件
    let query = supabase
      .from("card_usage_stats")
      .select("oracle_id, usage_rate")
      .eq("format", usageFormat)
      .eq("period_days", periodDays)
      .eq("calculated_at", latestRow.calculated_at)
      .limit(ID_LOOKUP_LIMIT);
    if (filters.usageRateMin !== undefined) query = query.gte("usage_rate", filters.usageRateMin);
    if (filters.usageRateMax !== undefined) query = query.lte("usage_rate", filters.usageRateMax);
    const { data } = await query;
    usageOracleIds = (data ?? []).map((r) => r.oracle_id);
    if (usageOracleIds.length === 0) return { results: [], totalCount: 0, capped: false };
  }

  // textOracleIds・usageOracleIdsはどちらも「事前にoracle_id候補を絞る」フィルタなので、
  // 両方指定されていれば積集合（AND）を取る
  let restrictOracleIds: string[] | null = null;
  if (textOracleIds && usageOracleIds) {
    const usageSet = new Set(usageOracleIds);
    restrictOracleIds = textOracleIds.filter((id) => usageSet.has(id));
    if (restrictOracleIds.length === 0) return { results: [], totalCount: 0, capped: false };
  } else {
    restrictOracleIds = textOracleIds ?? usageOracleIds;
  }

  // name/type/rarity/フォーマット適正の絞り込みを、渡されたクエリビルダーに適用する。
  // supabase-jsのビルダーはメソッドチェーンごとに型が変わり汎用的に型付けしづらいためanyで扱う。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyCommonFilters(q: any): any {
    let query = q;
    if (name) {
      query =
        jaNameOracleIds.length > 0
          ? query.or(`name.ilike.%${name}%,oracle_id.in.(${jaNameOracleIds.slice(0, ID_CHUNK).join(",")})`)
          : query.ilike("name", `%${name}%`);
    }
    // タイプ行キーワードは複数指定できる（クイック選択の複数選択＋手入力欄）。キーワードごとに
    // .or()をチェーンすると、supabase-jsはチェーンした複数の.or()をANDで組み合わせるため、
    // 「全てのキーワードにマッチする」絞り込みになる（例:「クリーチャー」+「エンチャント」→
    // エンチャント・クリーチャーだけがヒットする）。
    for (const orClause of typeOrClauses) query = query.or(orClause);
    if (filters.rarities && filters.rarities.length > 0) query = query.in("rarity", filters.rarities);
    // 複数フォーマットが選ばれている場合は「いずれかで合法」（OR）にする
    if (filters.formats && filters.formats.length > 0) {
      query = query.or(filters.formats.map((f) => `legalities->>${formatSlug(f)}.eq.legal`).join(","));
    }
    // マナ総量はcards.mana_value（mana_costから生成した計算列＋インデックス済み、db/schema.sql参照）で
    // SQL側に絞り込める。以前はJS側でしか判定できず、該当が多い/少ない条件だと候補を集めるのに
    // 何度もページを取りに行く必要があって遅かった（ネットワーク往復の積み重ねが支配的だった）。
    if (filters.mvBuckets && filters.mvBuckets.length > 0) {
      const exact = filters.mvBuckets.filter((b) => b !== "7+").map(Number);
      const orParts: string[] = [];
      if (exact.length > 0) orParts.push(`mana_value.in.(${exact.join(",")})`);
      if (filters.mvBuckets.includes("7+")) orParts.push("mana_value.gte.7");
      query = query.or(orParts.join(","));
    }
    // 登録日順ソート時はDB側で並べ替えてから走査する。こうしておくと、候補がCANDIDATE_CAPで
    // 打ち切られても「先頭CANDIDATE_CAP件」＝「実際の発売日順の先頭」になるため、
    // 該当件数が多い検索でも並び順が壊れない。価格順はcards側に価格の列・直接のFKが無く
    // （card_current_pricesはoracle_id単位で別テーブル）、同じ方法が使えないため対象外
    // （price順は依然としてCANDIDATE_CAPに達すると走査済みの範囲内でのみ正確）。
    if (filters.sortKey === "releasedAt") {
      query = query.order("released_at", { ascending: filters.sortDir === "asc", nullsFirst: false });
      // released_atは同点（同じ発売日）だらけなので、これだけだと.range()ページングの際に
      // PostgRESTが同点内の順序を保証せず、リクエストごとに順序が入れ替わって同じ行が複数
      // ページに重複して現れたり、逆に一件も現れないまま漏れたりする事故があった。
      // oracle_idを最終タイブレーカーにして並びを完全に決定的にする（oracle_idにインデックス
      // 済みなのでコストは小さい）。価格順（デフォルト）はSQL側で並べ替えていないため、
      // このタイブレーカーを付けても走査順の安定性には寄与せず、余計なソートコストが
      // 掛かるだけなのでreleasedAt時のみに限定する。
      query = query.order("oracle_id", { ascending: true });
    }
    return query;
  }

  // 色はDBに列を持たないため、行単位でJS側フィルタする（マナ総量はcards.mana_value列を
  // 追加してSQL側に絞り込めるようにした。上のapplyCommonFilters参照）。以前はSQLで拾った
  // 最初のCANDIDATE_CAP件（色を見る前の生の行）だけをJS側で絞り込んでいたため、他の条件が
  // 緩い検索だと該当カードがSQLの先頭CANDIDATE_CAP件より後ろに埋もれて拾われない事故があった。
  // ページングしながら都度この判定を通し、判定後の件数でCANDIDATE_CAPに達するまで
  // （＝実際にヒットする候補がCANDIDATE_CAP件集まるまで）SQL側を読み進める。
  function matchesRowFilters(c: CardRow): boolean {
    if (filters.colorlessOnly) {
      if (colorsFromManaCost(c.mana_cost).length !== 0) return false;
    } else if (filters.colors && filters.colors.length > 0) {
      const cardColors = colorsFromManaCost(c.mana_cost);
      if (!filters.colors.every((col) => cardColors.includes(col))) return false;
    }
    return true;
  }

  // SQL側の絞り込みがどれだけ緩くても走査量に上限を設けないと際限なく重くなるため、
  // 生の行の走査数自体にも安全弁を設ける（CANDIDATE_CAPよりかなり広めに取る）。
  const MAX_SCAN_ROWS = CANDIDATE_CAP * 20;
  const seenOracleIds = new Set<string>();
  const candidates: CardRow[] = [];

  // ページ（チャンク）は互いに独立なので、何往復も直列で待つと該当が少ない条件
  // （マナ総量の希少な値等）で待ち時間が積み上がる。BATCH_CONCURRENCYページ分をまとめて
  // 並列取得し、まだCANDIDATE_CAPに届かなければ次のバッチへ進む方式にする。
  // バッチ内の各ページはPromise.allの配列順（＝offset順）で処理するため、判定・打ち切りの
  // 結果は直列実行時と同じになる（並列化しても正しさは変わらない）。
  const BATCH_CONCURRENCY = 5;

  if (restrictOracleIds) {
    // restrictOracleIdsは千件規模のこともあり.in()に一括で渡せないため、チャンク分割して問い合わせる
    const chunks: string[][] = [];
    for (let i = 0; i < restrictOracleIds.length; i += ID_CHUNK) chunks.push(restrictOracleIds.slice(i, i + ID_CHUNK));

    for (let i = 0; i < chunks.length && candidates.length < CANDIDATE_CAP; i += BATCH_CONCURRENCY) {
      const batch = chunks.slice(i, i + BATCH_CONCURRENCY);
      const pages = await Promise.all(
        batch.map(async (chunk) => {
          const q = applyCommonFilters(supabase.from("cards").select(CARD_SELECT).eq("lang", "en").in("oracle_id", chunk));
          const { data } = (await q) as { data: CardRow[] | null };
          return data ?? [];
        }),
      );
      for (const page of pages) {
        for (const c of page) {
          if (seenOracleIds.has(c.oracle_id)) continue; // cardsは再録等で同じoracle_idの行が複数残ることがある
          if (!matchesRowFilters(c)) continue;
          seenOracleIds.add(c.oracle_id);
          candidates.push(c);
          if (candidates.length >= CANDIDATE_CAP) break;
        }
        if (candidates.length >= CANDIDATE_CAP) break;
      }
    }
  } else {
    const RANGE_PAGE_SIZE = 1000;
    let scanned = 0;
    let exhausted = false;
    // 最初の1回は単独リクエストで様子を見て（大半のケースはこれで足りる。cardsは1オラクルに
    // つき再録分などで複数行持つため、色フィルタが無くてもoracle_id単位のユニーク化で
    // CANDIDATE_CAPに届かないことがあり、その場合は自然に次のラウンドへ進んで追加取得する）、
    // それでも足りない時だけBATCH_CONCURRENCYページ分をまとめて並列取得する（毎回5並列で
    // 先読みすると、1ページで足りるケースまで無駄な同時接続を作ってしまい、かえって
    // 遅くなっていたため）。
    let roundSize = 1;
    for (
      let batchStart = 0;
      candidates.length < CANDIDATE_CAP && scanned < MAX_SCAN_ROWS && !exhausted;
      batchStart += roundSize * RANGE_PAGE_SIZE
    ) {
      const offsets = Array.from({ length: roundSize }, (_, i) => batchStart + i * RANGE_PAGE_SIZE);
      const pages = await Promise.all(
        offsets.map(async (offset) => {
          const q = applyCommonFilters(supabase.from("cards").select(CARD_SELECT).eq("lang", "en"));
          const { data, error } = (await q.range(offset, offset + RANGE_PAGE_SIZE - 1)) as {
            data: CardRow[] | null;
            error: unknown;
          };
          return error ? [] : (data ?? []);
        }),
      );
      for (const page of pages) {
        if (page.length === 0) {
          exhausted = true;
          break;
        }
        scanned += page.length;
        for (const c of page) {
          if (seenOracleIds.has(c.oracle_id)) continue;
          if (!matchesRowFilters(c)) continue;
          seenOracleIds.add(c.oracle_id);
          candidates.push(c);
          if (candidates.length >= CANDIDATE_CAP) break;
        }
        if (page.length < RANGE_PAGE_SIZE) {
          exhausted = true;
          break;
        }
        if (candidates.length >= CANDIDATE_CAP || scanned >= MAX_SCAN_ROWS) break;
      }
      roundSize = BATCH_CONCURRENCY;
    }
  }
  // CANDIDATE_CAPに達して打ち切った場合は「実際にはもっとある」ことを呼び出し側に伝える
  // （安全弁のMAX_SCAN_ROWSで打ち切られた場合も同様に不完全なので、その場合もcappedを立てる）
  const capped = candidates.length >= CANDIDATE_CAP;
  if (candidates.length === 0) return { results: [], totalCount: 0, capped: false };

  // 価格帯フィルタが無い場合でも一覧表示に価格を出したいので、候補全件分まとめて取得する
  const oracleIds = candidates.map((c) => c.oracle_id);
  const priceByOracle = await getJpyPricesByOracleIds(oracleIds);

  let withPrice = candidates.map((c) => ({ card: c, priceJpy: priceByOracle.get(c.oracle_id) ?? null }));
  if (filters.priceMin !== undefined || filters.priceMax !== undefined) {
    withPrice = withPrice.filter(({ priceJpy }) => {
      if (priceJpy === null) return false; // 価格帯指定時は価格不明なカードは対象外にする
      if (filters.priceMin !== undefined && priceJpy < filters.priceMin) return false;
      if (filters.priceMax !== undefined && priceJpy > filters.priceMax) return false;
      return true;
    });
  }
  if (withPrice.length === 0) return { results: [], totalCount: 0, capped: false };

  // 価格変化率は候補（最大でもCANDIDATE_CAP件）に対してだけ計算する。
  // dbCardRanking.tsの3日変化率計算と同じ「直近日と、指定日数前以前で一番近い日」の比較方式。
  let withChange = withPrice.map((r) => ({ ...r, priceChangePct: null as number | null }));
  if (filters.priceChangeMin !== undefined || filters.priceChangeMax !== undefined) {
    const periodDays = filters.priceChangePeriodDays ?? 7;
    const changeOracleIds = withPrice.map((r) => r.card.oracle_id);
    const rowsByOracle = new Map<string, { date: string; jpy: number }[]>();

    // 7日前比（UIのデフォルト・最頻値）はR2の事前計算済みキャッシュ（price-changes/latest.ndjson.gz、
    // 直近7日分の系列を含む）が1回のGetObjectでカバーできるので、そちらを使う。
    // 30日・90日はキャッシュの範囲外なので、従来通りオラクルごとに個別取得する
    // （オプトインの絞り込み機能で頻度も低いため、体感速度より実装の単純さを優先する）。
    if (periodDays === 7) {
      const recentChanges = await getR2RecentPriceChanges();
      for (const oracleId of changeOracleIds) {
        const series = recentChanges.get(oracleId)?.recentSeries;
        if (series && series.length > 0) rowsByOracle.set(oracleId, series.map((p) => ({ date: p.date, jpy: p.jpy })));
      }
    } else {
      const sinceDate = new Date();
      sinceDate.setUTCDate(sinceDate.getUTCDate() - (periodDays + 7)); // 比較対象日+マージン
      const sinceDateStr = sinceDate.toISOString().slice(0, 10);
      const chunks: string[][] = [];
      for (let i = 0; i < changeOracleIds.length; i += 50) chunks.push(changeOracleIds.slice(i, i + 50));
      const priceRowChunks = await Promise.all(chunks.map((chunk) => getRecentPriceHistoryForOracles(chunk, sinceDateStr)));
      for (const r of priceRowChunks.flat()) {
        if (!rowsByOracle.has(r.oracleId)) rowsByOracle.set(r.oracleId, []);
        rowsByOracle.get(r.oracleId)!.push({ date: r.date, jpy: r.jpy });
      }
    }

    withChange = withPrice.map((r) => {
      const series = rowsByOracle.get(r.card.oracle_id);
      if (!series || series.length === 0) return { ...r, priceChangePct: null };
      const latest = series.reduce((a, b) => (b.date > a.date ? b : a));
      const pastDate = new Date(`${latest.date}T00:00:00Z`);
      pastDate.setUTCDate(pastDate.getUTCDate() - periodDays);
      const pastDateStr = pastDate.toISOString().slice(0, 10);
      const past = series.filter((p) => p.date <= pastDateStr).reduce((a, b) => (!a || b.date > a.date ? b : a), null as { date: string; jpy: number } | null);
      if (!past || past.jpy === 0) return { ...r, priceChangePct: null };
      const pct = Math.round(((latest.jpy - past.jpy) / past.jpy) * 10000) / 100;
      return { ...r, priceChangePct: pct };
    });

    withChange = withChange.filter((r) => {
      if (r.priceChangePct === null) return false; // 変化率が計算できないカードは対象外
      if (filters.priceChangeMin !== undefined && r.priceChangePct < filters.priceChangeMin) return false;
      if (filters.priceChangeMax !== undefined && r.priceChangePct > filters.priceChangeMax) return false;
      return true;
    });
  }
  if (withChange.length === 0) return { results: [], totalCount: 0, capped: false };

  // 価格順（価格不明は末尾）・登録日順（新しい順、日付不明は末尾）を選べる。デフォルトは価格順
  // （価格が高いカードほど有名で見覚えがあることが多いため）。totalCountは全フィルタ適用後・
  // ページング前の件数（ページ送りの総ページ数計算に使う）。
  const sortKey = filters.sortKey ?? "price";
  const sortDir = filters.sortDir ?? "desc";
  const dirMul = sortDir === "asc" ? 1 : -1;
  withChange.sort((a, b) => {
    if (sortKey === "releasedAt") {
      const av = a.card.released_at ?? "";
      const bv = b.card.released_at ?? "";
      if (av === "" && bv === "") return 0;
      if (av === "") return 1; // 日付不明は常に末尾
      if (bv === "") return -1;
      return dirMul * av.localeCompare(bv);
    }
    if (a.priceJpy === null && b.priceJpy === null) return 0;
    if (a.priceJpy === null) return 1; // 価格不明は常に末尾
    if (b.priceJpy === null) return -1;
    return dirMul * (a.priceJpy - b.priceJpy);
  });
  const totalCount = withChange.length;
  const sorted = withChange.slice(offset, offset + limit);
  if (sorted.length === 0) return { results: [], totalCount, capped };

  // 日本語名・日本語版画像は別途まとめて取得する（候補が絞れた後なのでコストは小さい）
  const finalOracleIds = sorted.map((r) => r.card.oracle_id);
  const [{ data: oracles }, { data: jaCards }] = await Promise.all([
    supabase.from("card_oracles").select("oracle_id, printed_name_ja").in("oracle_id", finalOracleIds),
    supabase
      .from("cards")
      .select("oracle_id, image_uri_normal")
      .eq("lang", "ja")
      .in("oracle_id", finalOracleIds),
  ]);
  const nameJaByOracle = new Map((oracles ?? []).map((o) => [o.oracle_id, o.printed_name_ja]));
  const jaImageByOracle = new Map((jaCards ?? []).map((c) => [c.oracle_id, c.image_uri_normal]));

  const results = sorted.map(({ card, priceJpy }) => ({
    oracleId: card.oracle_id,
    nameEn: card.name,
    nameJa: nameJaByOracle.get(card.oracle_id) ?? null,
    imageUrl: jaImageByOracle.get(card.oracle_id) ?? card.image_uri_normal,
    typeLine: card.type_line,
    rarity: card.rarity,
    priceJpy,
  }));
  return { results, totalCount, capped };
}
