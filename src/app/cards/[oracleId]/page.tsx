import Image from "next/image";
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
  resolveImageUris,
  RARITY_LABEL_JA,
} from "@/lib/scryfall";
import { fetchExchangeRates, toJpy, formatJpy } from "@/lib/fx";
import { SAMPLE_CARD_SLUGS } from "@/lib/sampleCards";
import { getArchetypesUsingCard } from "@/lib/sampleDeckDetail";
import { getFormatUsageCountsForCard } from "@/lib/dbCardUsageByFormat";
import { getPriceHistoryForCard, type PricePoint } from "@/lib/dbPriceHistory";
import { getOtherPrintsForCard } from "@/lib/dbCardPrints";
import PriceHistoryChart from "@/components/PriceHistoryChart";
import {
  getCardDetailFromDb,
  getCardDetailByOracleId,
  getLatestPriceSnapshot,
  fetchPriceByScryfallId,
  type DbCardDetail,
} from "@/lib/cardData";
import LegalityGrid from "@/components/LegalityGrid";

interface ResolvedCard {
  oracleId: string | null;
  nameJa: string | null;
  nameEn: string;
  setName: string;
  setCode: string;
  collectorNumber: string;
  rarity: string;
  typeLine: string | null;
  legalities: Record<string, string>;
  imageUrl: string | null;
  usdPrice: number | null;
  source: "db" | "live";
}

async function resolveCardFromDbDetail(dbResult: DbCardDetail): Promise<ResolvedCard> {
  const { oracle, enCard, jaCard } = dbResult;
  // card_price_snapshots（日次バッチで投入済み）優先、無ければライブ取得にフォールバック
  const snapshot = await getLatestPriceSnapshot(oracle.oracle_id, "en");
  let usdPrice: number | null = snapshot?.usd ?? null;
  if (usdPrice === null) {
    const livePrice = await fetchPriceByScryfallId(enCard.scryfall_id);
    usdPrice = livePrice?.usd ? parseFloat(livePrice.usd) : null;
  }
  return {
    oracleId: oracle.oracle_id,
    // 同一プリントの日本語版（jaCard）が無い場合、card_oracles.printed_name_jaに
    // 他プリントからのフォールバック済みの名前が入っていればそちらを使う
    // （例: Hallowed Fountainの代表英語版がJP版の無いプリントだった場合）。
    nameJa: jaCard?.printed_name_ja ?? enCard.printed_name_ja ?? oracle.printed_name_ja,
    nameEn: enCard.name,
    setName: enCard.set_name,
    setCode: enCard.set_code,
    collectorNumber: enCard.collector_number,
    rarity: enCard.rarity,
    typeLine: (jaCard?.type_line || enCard.type_line) ?? null,
    legalities: enCard.legalities,
    imageUrl: jaCard?.image_uri_normal ?? enCard.image_uri_normal,
    usdPrice,
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
    nameJa: displayName.sub ? displayName.main : null,
    nameEn: enFrontName,
    setName: enCard.set_name,
    setCode: enCard.set,
    collectorNumber: enCard.collector_number,
    rarity: enCard.rarity,
    typeLine:
      (jaCard && resolveFrontFacePrintedTypeLine(jaCard)) ??
      resolveFrontFaceTypeLine(enCard) ??
      null,
    legalities: enCard.legalities,
    imageUrl:
      (jaCard && resolveImageUris(jaCard)?.normal) ?? resolveImageUris(enCard)?.normal ?? null,
    usdPrice: enCard.prices.usd ? parseFloat(enCard.prices.usd) : null,
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

// 実物が角丸ではない（角が四角い）ことで知られるセットの一覧。角丸カードかどうかを毎回
// 判定するより、角が四角い方が少数派で既知のセットに限られるため、こちらを列挙する方が楽。
const SQUARE_CORNER_SET_CODES = new Set(["ced", "cei"]);

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

  const [card, rates] = await Promise.all([resolveCardByParam(oracleId), fetchExchangeRates()]);
  if (!card) notFound();

  const jpyPrice = card.usdPrice !== null ? toJpy(card.usdPrice, rates.usdToJpy) : null;
  const relatedArchetypes = getArchetypesUsingCard(card.nameEn);
  const formatUsageCounts = card.oracleId
    ? await getFormatUsageCountsForCard(card.oracleId, usagePeriodDays)
    : [];
  const [enPriceHistory, jaPriceHistory] = card.oracleId
    ? await Promise.all([
        getPriceHistoryForCard(card.oracleId, "en"),
        getPriceHistoryForCard(card.oracleId, "ja"),
      ])
    : [[], []];
  const priceExtremes = getPriceExtremes(enPriceHistory);
  const otherPrints = card.oracleId
    ? await getOtherPrintsForCard(card.oracleId, {
        setCode: card.setCode,
        collectorNumber: card.collectorNumber,
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        {card.imageUrl && (
          <Image
            src={card.imageUrl}
            alt={card.nameEn}
            width={223}
            height={311}
            className={`h-fit w-[180px] shrink-0 border border-neutral-200 object-cover ${
              SQUARE_CORNER_SET_CODES.has(card.setCode) ? "" : "rounded-xl"
            }`}
          />
        )}
        <div className="flex flex-1 flex-col gap-4">
          <div>
            <p className="text-xl font-medium">{card.nameJa ?? card.nameEn}</p>
            {card.nameJa && <p className="text-sm text-neutral-500">{card.nameEn}</p>}
            {card.typeLine && <p className="mt-2 text-sm text-neutral-600">{card.typeLine}</p>}
            <p className="mt-1 text-sm text-neutral-500">
              {card.setName} ・ {RARITY_LABEL_JA[card.rarity] ?? card.rarity}
            </p>
            {jpyPrice !== null ? (
              <>
                <p className="mt-4 text-2xl font-medium">{formatJpy(jpyPrice)}</p>
                <p className="text-xs text-neutral-400">
                  為替換算の参考値（${card.usdPrice?.toFixed(2)} × {rates.usdToJpy.toFixed(2)}円/$）
                </p>
              </>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">価格データなし</p>
            )}
            {priceExtremes && (
              <p className="mt-2 text-xs text-neutral-500">
                最高値: ¥{priceExtremes.maxJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                （{formatDateSlash(priceExtremes.maxDate)}） ／ 最安値: ¥
                {priceExtremes.minJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                （{formatDateSlash(priceExtremes.minDate)}）
                <br />
                <span className="text-neutral-400">
                  ※日次スナップショットの記録が残っている範囲内での最高値・最安値です
                </span>
              </p>
            )}
          </div>

          <PriceHistoryChart enHistory={enPriceHistory} jaHistory={jaPriceHistory} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500">フォーマットリーガル</h2>
          <LegalityGrid legalities={card.legalities} />
        </div>

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
                    <span className="text-right tabular-nums">{f.deckCount}件</span>
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
            <p className="mt-2 text-xs text-neutral-400">※（）は直前の同じ期間との比較</p>
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

        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500">その他のプリント</h2>
          <p className="mb-3 text-xs text-neutral-400">
            価格・画像は代表プリントのみ追跡しています（データ肥大化対策、db/schema.sql 8章参照）。
          </p>
          {otherPrints.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {otherPrints.map((p) => (
                <li key={p.scryfallId}>
                  <Link
                    href={`/cards/${oracleId}/prints/${p.scryfallId}`}
                    className="flex flex-col gap-1 hover:opacity-80"
                  >
                    {p.imageUrl ? (
                      <Image
                        src={p.imageUrl}
                        alt={p.setName}
                        width={146}
                        height={204}
                        className={`w-full ${SQUARE_CORNER_SET_CODES.has(p.setCode) ? "" : "rounded"}`}
                      />
                    ) : (
                      <div className="flex aspect-[5/7] w-full items-center justify-center rounded bg-neutral-100 text-xs text-neutral-400">
                        画像なし
                      </div>
                    )}
                    <span className="truncate text-xs text-neutral-600">{p.setName}</span>
                    <span className="text-xs text-neutral-400">{p.releasedAt?.slice(0, 4) ?? "-"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">他のプリントは見つかりませんでした。</p>
          )}
        </div>
      </div>
    </div>
  );
}
