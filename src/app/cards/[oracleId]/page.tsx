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

export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ oracleId: string }>;
}) {
  const { oracleId } = await params;

  const [card, rates] = await Promise.all([resolveCardByParam(oracleId), fetchExchangeRates()]);
  if (!card) notFound();

  const jpyPrice = card.usdPrice !== null ? toJpy(card.usdPrice, rates.usdToJpy) : null;
  const relatedArchetypes = getArchetypesUsingCard(card.nameEn);
  const formatUsageCounts = card.oracleId ? await getFormatUsageCountsForCard(card.oracleId) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        {card.imageUrl && (
          <Image
            src={card.imageUrl}
            alt={card.nameEn}
            width={223}
            height={311}
            className="h-fit w-[180px] shrink-0 rounded-xl border border-neutral-200 object-cover"
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
          </div>

          <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-neutral-500">
            TODO: 円建て価格推移チャート（期間切替、JP/EN比較トグル）。Scryfallは現在価格のみ提供のため、
            日次スナップショットは card_price_snapshots（db/schema.sql）に蓄積してから表示する。
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500">フォーマットリーガル</h2>
          <LegalityGrid legalities={card.legalities} />
        </div>

        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500">使用デッキ（直近7日間）</h2>
          {formatUsageCounts.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {formatUsageCounts.map((f) => (
                <li key={f.format} className="flex items-center justify-between">
                  <span>{f.format}</span>
                  <span>
                    {f.deckCount7d}件
                    {f.changePct !== null && (
                      <span
                        className={`ml-1 text-xs ${f.changePct < 0 ? "text-red-800" : "text-teal-800"}`}
                      >
                        （{f.changePct >= 0 ? "+" : ""}
                        {f.changePct}%）
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : relatedArchetypes.length > 0 ? (
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
          )}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500">その他のプリント</h2>
          <p className="text-sm text-neutral-500">
            価格・画像は代表プリントのみ追跡しています（データ肥大化対策、db/schema.sql 8章参照）。
          </p>
        </div>
      </div>
    </div>
  );
}
