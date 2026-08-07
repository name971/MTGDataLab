import Link from "next/link";
import { notFound } from "next/navigation";
import {
  fetchCardByFuzzyName,
  fetchJapanesePrint,
  resolveDisplayName,
  resolveFrontFaceName,
  resolveFrontFacePrintedName,
  resolveFrontFacePrintedTypeLine,
  resolveFrontFaceTypeLine,
  resolveCombinedOracleText,
  resolveCombinedPrintedText,
  resolveImageUris,
  RARITY_LABEL_JA,
} from "@/lib/scryfall";
import { toJpy } from "@/lib/fx";
import { SAMPLE_CARD_SLUGS } from "@/lib/sampleCards";
import { getArchetypesUsingCard } from "@/lib/sampleDeckDetail";
import { getFormatUsageCountsForCard } from "@/lib/dbCardUsageByFormat";
import type { PricePoint } from "@/lib/dbPriceHistory";
import { getCheapestPriceHistory, getLatestCheapestPrice } from "@/lib/dbCheapestPrice";
import { getOtherPrintsForCard, getBestCardImage } from "@/lib/dbCardPrints";
import { getLatestPricesForPrints } from "@/lib/dbCardPrintPrices";
import { translateTypeLine } from "@/lib/typeGlossary";
import CardHero from "@/components/CardHero";
import {
  getCardDetailFromDb,
  getCardDetailByOracleId,
  fetchPriceByScryfallId,
  getLatestPrintUsd,
  getLatestUsdToJpyRate,
  type DbCardDetail,
} from "@/lib/cardData";

interface ResolvedCard {
  oracleId: string | null;
  scryfallId: string | null;
  nameJa: string | null;
  nameEn: string;
  setName: string;
  setCode: string;
  collectorNumber: string;
  rarity: string;
  typeLine: string | null;
  manaCost: string | null;
  power: string | null;
  toughness: string | null;
  oracleText: string | null;
  legalities: Record<string, string>;
  imageUrl: string | null;
  usdPrice: number | null;
  usdPriceFoil: number | null;
  // スナップショットに保存済みの円換算値（記録日時点のレートで計算済み）。価格推移グラフの
  // 最新点もこの値そのものを表示しているため、ヘッダーの現在価格もこちらを優先して使うことで
  // グラフの右端と一致させる。null（スナップショット無し・ライブ取得フォールバック時）の場合のみ
  // 呼び出し側でその場のライブ為替レートから計算する。
  jpyPrice: number | null;
  jpyPriceFoil: number | null;
  source: "db" | "live";
}

async function resolveCardFromDbDetail(dbResult: DbCardDetail): Promise<ResolvedCard> {
  const { oracle, enCard, jaCard, fallbackTypeLineJa, fallbackTextJa } = dbResult;
  // card_cheapest_price_snapshots（日次バッチで投入済み、全プリント横断の最安値）優先、
  // 無ければライブ取得にフォールバック
  const [snapshot, bestImage] = await Promise.all([
    getLatestCheapestPrice(oracle.oracle_id),
    getBestCardImage(oracle.oracle_id),
  ]);
  let usdPrice: number | null = snapshot?.usd ?? null;
  let jpyPrice: number | null = snapshot?.jpyEst ?? null;
  if (usdPrice === null) {
    // card_cheapest_price_snapshotsが未生成でも、card_print_prices（プリント単位の日次価格）
    // には既にデータがあることが多いため、ライブ取得より先にこちらをDBだけで試す。
    usdPrice = await getLatestPrintUsd(enCard.scryfall_id);
    if (usdPrice === null) {
      const livePrice = await fetchPriceByScryfallId(enCard.scryfall_id);
      usdPrice = livePrice?.usd ? parseFloat(livePrice.usd) : null;
    }
    jpyPrice = null; // ライブ取得分は換算済みの値を持たないため、呼び出し側でその場のレートから計算する
  }
  return {
    oracleId: oracle.oracle_id,
    scryfallId: enCard.scryfall_id,
    // 同一プリントの日本語版（jaCard）が無い場合、card_oracles.printed_name_jaに
    // 他プリントからのフォールバック済みの名前が入っていればそちらを使う
    // （例: Hallowed Fountainの代表英語版がJP版の無いプリントだった場合）。
    nameJa: jaCard?.printed_name_ja ?? enCard.printed_name_ja ?? oracle.printed_name_ja,
    nameEn: enCard.name,
    setName: enCard.set_name,
    setCode: enCard.set_code,
    collectorNumber: enCard.collector_number,
    rarity: enCard.rarity,
    // 実際の日本語版プリント訳が無ければ、辞書（typeGlossary.ts）で機械的に翻訳する。
    // 辞書に無い語（未知のクリーチャー・タイプ等）はそのまま英語で残る。
    typeLine:
      (jaCard?.printed_type_line ||
        fallbackTypeLineJa ||
        (enCard.type_line ? translateTypeLine(enCard.type_line) : null)) ??
      null,
    manaCost: enCard.mana_cost,
    power: enCard.power,
    toughness: enCard.toughness,
    // 日本語版プリントのルールテキスト訳（printed_text_ja）があればそちらを優先するが、
    // 代表プリントがUniverses Beyond版でフレーバー名に差し替わっている場合はfallbackTextJa
    // （非コラボ版のテキスト）を優先する。どちらも無ければ英語のoracle_textにフォールバック。
    oracleText: fallbackTextJa ?? jaCard?.printed_text_ja ?? oracle.oracle_text,
    legalities: enCard.legalities,
    // 「一番安いプリントから順に見て、日本語版画像があればそれを採用」というアルゴリズムで
    // card_printsから選ぶ（getBestCardImage）。card_prints未反映（新規カード等）でnullの場合のみ、
    // 従来通りcardsテーブルの代表プリント画像にフォールバックする。
    imageUrl: bestImage ?? jaCard?.image_uri_normal ?? enCard.image_uri_normal,
    usdPrice,
    jpyPrice,
    usdPriceFoil: snapshot?.usdFoil ?? null,
    jpyPriceFoil: snapshot?.jpyEstFoil ?? null,
    source: "db",
  };
}

/** 実トーナメントデータ由来のカード（サンプルの22枚と違いスラグを持たない）をoracle_id直指定で解決する */
async function resolveCardByOracleId(oracleId: string): Promise<ResolvedCard | null> {
  const dbResult = await getCardDetailByOracleId(oracleId);
  if (!dbResult) return null;
  return resolveCardFromDbDetail(dbResult);
}

async function resolveCard(searchName: string): Promise<ResolvedCard | null> {
  const dbResult = await getCardDetailFromDb(searchName);
  if (dbResult) {
    return resolveCardFromDbDetail(dbResult);
  }

  // DB未インポートのカードはScryfallをライブで取得する（フォールバック）
  const enCard = await fetchCardByFuzzyName(searchName);
  if (!enCard) return null;
  const jaCard = await fetchJapanesePrint(enCard.name);
  const enFrontName = resolveFrontFaceName(enCard);
  const displayName = resolveDisplayName({
    name: enFrontName,
    printed_name: jaCard ? resolveFrontFacePrintedName(jaCard) : undefined,
  });
  return {
    oracleId: null,
    scryfallId: enCard.id,
    nameJa: displayName.sub ? displayName.main : null,
    nameEn: enFrontName,
    setName: enCard.set_name,
    setCode: enCard.set,
    collectorNumber: enCard.collector_number,
    rarity: enCard.rarity,
    typeLine:
      (jaCard && resolveFrontFacePrintedTypeLine(jaCard)) ??
      (() => {
        const en = resolveFrontFaceTypeLine(enCard);
        return en ? translateTypeLine(en) : null;
      })(),
    manaCost: enCard.mana_cost ?? enCard.card_faces?.[0]?.mana_cost ?? null,
    power: enCard.power ?? enCard.card_faces?.[0]?.power ?? null,
    toughness: enCard.toughness ?? enCard.card_faces?.[0]?.toughness ?? null,
    oracleText: (jaCard && resolveCombinedPrintedText(jaCard)) ?? resolveCombinedOracleText(enCard),
    legalities: enCard.legalities,
    imageUrl:
      (jaCard && resolveImageUris(jaCard)?.normal) ?? resolveImageUris(enCard)?.normal ?? null,
    usdPrice: enCard.prices.usd ? parseFloat(enCard.prices.usd) : null,
    jpyPrice: null,
    usdPriceFoil: null,
    jpyPriceFoil: null,
    source: "live",
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCardByParam(oracleId: string): Promise<ResolvedCard | null> {
  const searchName = SAMPLE_CARD_SLUGS[oracleId];
  if (searchName) return resolveCard(searchName);
  // 実トーナメントデータ由来のカードはスラグを持たず、oracle_id（UUID）がそのままURLになる
  if (UUID_PATTERN.test(oracleId)) return resolveCardByOracleId(oracleId);
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ oracleId: string }>;
}) {
  const { oracleId } = await params;
  const card = await resolveCardByParam(oracleId);
  if (!card) return { title: "MTG DataLab" };

  return { title: `${card.nameJa ?? card.nameEn} - MTG DataLab` };
}

const USAGE_PERIOD_OPTIONS = [7, 30, 90] as const;
type UsagePeriodDays = (typeof USAGE_PERIOD_OPTIONS)[number];

function resolveUsagePeriod(raw: string | undefined): UsagePeriodDays {
  const n = Number(raw);
  return (USAGE_PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as UsagePeriodDays) : 7;
}

/** スナップショット履歴（記録が残っている範囲）内での最高値・最安値とその日付 */
function getPriceExtremes(
  history: PricePoint[],
): { maxJpy: number; maxDate: string; minJpy: number; minDate: string } | null {
  if (history.length === 0) return null;
  let max = history[0];
  let min = history[0];
  for (const p of history) {
    if (p.jpy > max.jpy) max = p;
    if (p.jpy < min.jpy) min = p;
  }
  return { maxJpy: max.jpy, maxDate: max.date, minJpy: min.jpy, minDate: min.date };
}

/** "2026-07-25" -> "2026/7/25" */
function formatDateSlash(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

export default async function CardDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ oracleId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { oracleId } = await params;
  const { period } = await searchParams;
  const usagePeriodDays = resolveUsagePeriod(period);

  const card = await resolveCardByParam(oracleId);
  if (!card) notFound();

  // ヘッダーの現在価格は、スナップショット保存済みのjpy_est（記録日時点のレートで計算済み）を
  // そのまま使う。価格推移グラフの最新点も同じjpy_estを表示しているため、これでヘッダーと
  // グラフの右端が必ず一致する。ライブ為替APIをその場で叩いて再計算するフォールバックは
  // 廃止した（毎回外部APIを叩くコストがかかる上、バッチ実行時のレートとズレて逆に不一致の原因に
  // なっていたため）。
  // ただし、インポートしたばかりでcard_cheapest_price_snapshotsがまだ無い（＝jpy_estが無い）
  // カードは、usdだけ取れていてもそのまま「価格データなし」になってしまうので、その場合だけ
  // exchange_rates（既にDBにある、外部APIを叩かない）の直近レートで仮計算する。
  const needsRateFallback =
    (card.jpyPrice === null && card.usdPrice !== null) ||
    (card.jpyPriceFoil === null && card.usdPriceFoil !== null);
  const fallbackRate = needsRateFallback ? await getLatestUsdToJpyRate() : null;

  const jpyPrice =
    card.jpyPrice ?? (card.usdPrice !== null && fallbackRate !== null ? toJpy(card.usdPrice, fallbackRate) : null);
  const jpyPriceFoil =
    card.jpyPriceFoil ??
    (card.usdPriceFoil !== null && fallbackRate !== null ? toJpy(card.usdPriceFoil, fallbackRate) : null);
  // 「為替換算の参考値（$X × Y円/$）」の掛け算が実際の表示価格と食い違わないよう、
  // YはjpyPriceから逆算した実効レート（スナップショット由来ならバッチ実行時のレート、
  // 仮計算ならexchange_ratesの直近レートそのもの）を使う。
  const usdToJpyRate = card.usdPrice && jpyPrice !== null ? jpyPrice / card.usdPrice : 0;
  const usdToJpyRateFoil = card.usdPriceFoil && jpyPriceFoil !== null ? jpyPriceFoil / card.usdPriceFoil : 0;
  const relatedArchetypes = getArchetypesUsingCard(card.nameEn);
  const formatUsageCounts = card.oracleId
    ? await getFormatUsageCountsForCard(card.oracleId, usagePeriodDays)
    : [];
  const [enPriceHistory, enFoilPriceHistory] = card.oracleId
    ? await Promise.all([
        getCheapestPriceHistory(card.oracleId),
        getCheapestPriceHistory(card.oracleId, "foil"),
      ])
    : [[], []];
  const priceExtremes = getPriceExtremes(enPriceHistory);
  const priceExtremesFoil = getPriceExtremes(enFoilPriceHistory);
  // 「代表プリント」を先頭固定表示で除外する仕組みは廃止したため、除外条件無しで全プリントを取得する
  // （カードデータが参照している最安値のプリントも、他のプリントと同列の1行として一覧に出したい）。
  const otherPrints = card.oracleId ? await getOtherPrintsForCard(card.oracleId) : [];
  const otherPrintPrices = await getLatestPricesForPrints(otherPrints.map((p) => p.scryfallId));

  // 「カードデータ」欄のレアリティは代表プリント1件のものではなく、これまでに出た全プリントの
  // レアリティを集計して表示する（再録でレアリティが変わることがあるため）。
  // rarity未反映（scripts/rebuild-card-prints.mjs未実行）の古いcard_prints行はnullなので除外する。
  const RARITY_ORDER = ["common", "uncommon", "rare", "mythic"] as const;
  const allRarities = [...new Set([card.rarity, ...otherPrints.map((p) => p.rarity).filter((r) => r !== null)])];
  const allRarityLabels = allRarities
    .sort((a, b) => RARITY_ORDER.indexOf(a as (typeof RARITY_ORDER)[number]) - RARITY_ORDER.indexOf(b as (typeof RARITY_ORDER)[number]))
    .map((r) => RARITY_LABEL_JA[r] ?? r)
    .join(" / ");

  const priceExtremesText = priceExtremes
    ? `最安値: ¥${priceExtremes.minJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}（${formatDateSlash(priceExtremes.minDate)}） ／ 最高値: ¥${priceExtremes.maxJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}（${formatDateSlash(priceExtremes.maxDate)}）\n※日次スナップショットの記録が残っている範囲内での最高値・最安値です`
    : null;
  const priceExtremesFoilText = priceExtremesFoil
    ? `最安値: ¥${priceExtremesFoil.minJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}（${formatDateSlash(priceExtremesFoil.minDate)}） ／ 最高値: ¥${priceExtremesFoil.maxJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}（${formatDateSlash(priceExtremesFoil.maxDate)}）\n※日次スナップショットの記録が残っている範囲内での最高値・最安値です`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <CardHero
        oracleId={oracleId}
        defaultPrint={{
          scryfallId: card.scryfallId,
          imageUrl: card.imageUrl,
          nameJa: card.nameJa,
          nameEn: card.nameEn,
          typeLine: card.typeLine,
          manaCost: card.manaCost,
          power: card.power,
          toughness: card.toughness,
          oracleText: card.oracleText,
          setName: card.setName,
          setCode: card.setCode,
          collectorNumber: card.collectorNumber,
          rarityLabel: allRarityLabels,
          jpyPrice,
          jpyPriceFoil,
          usdPrice: card.usdPrice,
          usdPriceFoil: card.usdPriceFoil,
          usdToJpyRate,
          usdToJpyRateFoil,
          priceExtremesText,
          priceExtremesFoilText,
        }}
        defaultEnHistory={enPriceHistory}
        defaultEnFoilHistory={enFoilPriceHistory}
        otherPrints={otherPrints}
        pricesByScryfallId={Object.fromEntries(otherPrintPrices.normal)}
        foilPricesByScryfallId={Object.fromEntries(otherPrintPrices.foil)}
        legalities={card.legalities}
      >
        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">使用デッキ</h2>
          <div className="mb-3 flex items-center gap-1">
            {USAGE_PERIOD_OPTIONS.map((p) => (
              <Link
                key={p}
                href={`/cards/${oracleId}${p !== 7 ? `?period=${p}` : ""}`}
                className={`rounded-md border px-2 py-0.5 text-xs ${
                  p === usagePeriodDays
                    ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                    : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                }`}
              >
                {p}日
              </Link>
            ))}
          </div>
          {formatUsageCounts.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {formatUsageCounts.map((f) => (
                <li key={f.format} className="flex items-center justify-between gap-2">
                  <Link
                    href={`/cards/${oracleId}/decks?format=${encodeURIComponent(f.format)}&period=${usagePeriodDays}`}
                    className="hover:underline"
                  >
                    {f.format}
                  </Link>
                  <span className="flex shrink-0 items-baseline justify-end">
                    <span className="w-10 text-right tabular-nums">{f.deckCount}件</span>
                    <span
                      className={`ml-1 w-16 shrink-0 text-right text-xs tabular-nums ${
                        f.changePct === null ? "" : f.changePct < 0 ? "text-red-800" : "text-teal-800"
                      }`}
                    >
                      {f.changePct !== null && (
                        <>
                          （{f.changePct >= 0 ? "+" : ""}
                          {f.changePct}%）
                        </>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {formatUsageCounts.some((f) => f.changePct !== null) && (
            <p className="mt-2 text-xs text-neutral-400">※（）は直前の同じ期間との採用率の変化率</p>
          )}
          {formatUsageCounts.length === 0 &&
            (relatedArchetypes.length > 0 ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {relatedArchetypes.map((a) => (
                  <li key={a.archetypeId}>
                    <Link href={`/decks/${a.archetypeId}`} className="hover:underline">
                      {a.archetypeNameJa}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">
                現在このカードを使用しているデッキは登録されていません。
              </p>
            ))}
        </div>
      </CardHero>
    </div>
  );
}
