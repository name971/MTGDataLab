import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCardPrintByScryfallId } from "@/lib/dbCardPrints";
import { getPrintPriceHistory } from "@/lib/dbCardPrintPrices";
import { getCardDetailFromDb, getCardDetailByOracleId, type DbCardDetail } from "@/lib/cardData";
import { RARITY_LABEL_JA } from "@/lib/scryfall";
import { SAMPLE_CARD_SLUGS } from "@/lib/sampleCards";
import PriceHistoryChart from "@/components/PriceHistoryChart";
import LegalityGrid from "@/components/LegalityGrid";
import ManaText from "@/components/ManaText";

/**
 * URLの[oracleId]は「サンプル22枚のスラグ（例: "ragavan"）」と「実データのUUID」の
 * どちらもありうる（src/app/cards/[oracleId]/page.tsxのresolveCardByParamと同じ判定）。
 */
async function resolveCardDetail(oracleId: string): Promise<DbCardDetail | null> {
  const searchName = SAMPLE_CARD_SLUGS[oracleId];
  if (searchName) return getCardDetailFromDb(searchName);
  return getCardDetailByOracleId(oracleId);
}

/** "2026-07-25" -> "2026/7/25" */
function formatDateSlash(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

// 実物が角丸ではない（角が四角い）ことで知られるセットの一覧。角丸カードかどうかを毎回
// 判定するより、角が四角い方が少数派で既知のセットに限られるため、こちらを列挙する方が楽。
const SQUARE_CORNER_SET_CODES = new Set(["ced", "cei"]);

export default async function CardPrintDetailPage({
  params,
}: {
  params: Promise<{ oracleId: string; scryfallId: string }>;
}) {
  const { oracleId, scryfallId } = await params;

  const [print, card, priceHistory, foilPriceHistory] = await Promise.all([
    getCardPrintByScryfallId(scryfallId),
    resolveCardDetail(oracleId),
    getPrintPriceHistory(scryfallId, "normal"),
    getPrintPriceHistory(scryfallId, "foil"),
  ]);
  if (!print || print.scryfallId !== scryfallId || !card) notFound();

  const { oracle, enCard, jaCard, fallbackTypeLineJa, fallbackTextJa } = card;
  const nameJa = jaCard?.printed_name_ja ?? enCard.printed_name_ja ?? oracle.printed_name_ja;
  const nameEn = enCard.name;
  // 名前・タイプ・テキストはオラクル単位（プリントによってゲームルール上変わらない）で、
  // カード詳細ページ（src/app/cards/[oracleId]/page.tsx）と同じ解決ロジックを使う。
  // 画像・セット・価格だけがこのプリント固有の情報。
  const typeLine = (jaCard?.printed_type_line || fallbackTypeLineJa || enCard.type_line) ?? null;
  const oracleText = fallbackTextJa ?? jaCard?.printed_text_ja ?? oracle.oracle_text;

  // card_print_prices（scripts/snapshot-print-prices.mjsが日次で追記、db/schema.sql参照）の
  // 最新日を「現在価格」として表示する。まだ一度もスナップショットが無い場合は価格データなし。
  const latest = priceHistory.at(-1) ?? null;
  const latestFoil = foilPriceHistory.at(-1) ?? null;
  const jpyPrice = latest?.jpy ?? null;
  const jpyPriceFoil = latestFoil?.jpy ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/cards/${oracleId}`} className="text-sm text-neutral-500 hover:underline">
        ← {nameJa ?? nameEn} に戻る
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row">
        {print.imageUrl && (
          <Image
            src={print.imageUrl}
            alt={nameEn}
            width={223}
            height={311}
            className={`h-fit w-[180px] shrink-0 border border-neutral-200 object-cover ${
              SQUARE_CORNER_SET_CODES.has(print.setCode) ? "" : "rounded-xl"
            }`}
          />
        )}
        <div className="flex flex-1 flex-col gap-4">
          <div>
            <p className="flex flex-wrap items-center gap-x-2 text-xl font-medium">
              <span>{nameJa ?? nameEn}</span>
              {enCard.mana_cost && <ManaText text={enCard.mana_cost} symbolSize={20} align="middle" />}
            </p>
            {nameJa && <p className="text-sm text-neutral-500">{nameEn}</p>}
            {typeLine && <p className="mt-2 text-sm text-neutral-600">{typeLine}</p>}
            {oracleText && (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-neutral-700">
                <ManaText text={oracleText} />
              </p>
            )}
            {enCard.power !== null && enCard.toughness !== null && (
              <p className="mt-2 text-right text-sm font-medium text-neutral-700">
                {enCard.power}/{enCard.toughness}
              </p>
            )}
            {/* レアリティはcard_printsにプリント単位で持っていないため代表プリントのもので代用
                （マスターピース等の特殊枠は元のレアリティと異なることがある点に注意） */}
            <p className="mt-3 text-sm text-neutral-500">
              {print.setName}（#{print.collectorNumber}） ・ {RARITY_LABEL_JA[enCard.rarity] ?? enCard.rarity}
              {print.notTournamentLegal && (
                <span className="ml-1 rounded bg-red-50 px-1 text-[10px] text-red-700">使用不可</span>
              )}
            </p>
            {print.releasedAt && (
              <p className="text-sm text-neutral-500">発売日: {formatDateSlash(print.releasedAt)}</p>
            )}
            {jpyPrice !== null ? (
              <>
                <p className="mt-4 text-2xl font-medium">{jpyPrice.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}円</p>
                <p className="text-xs text-neutral-400">{latest?.date}時点の参考値</p>
              </>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">価格データなし</p>
            )}
            {jpyPriceFoil !== null && (
              <p className="text-sm text-neutral-500">
                Foil ¥{jpyPriceFoil.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}（{latestFoil?.date}時点）
              </p>
            )}
          </div>
        </div>
      </div>

      {(priceHistory.length > 0 || foilPriceHistory.length > 0) && (
        <PriceHistoryChart
          enHistory={priceHistory}
          enFoilHistory={foilPriceHistory}
          finish="normal"
        />
      )}

      <div className="rounded-lg border border-neutral-200 p-4 sm:max-w-md">
        <h2 className="mb-3 text-sm font-medium text-neutral-500">フォーマットリーガル</h2>
        <LegalityGrid legalities={enCard.legalities} disabled={print.notTournamentLegal} />
      </div>
    </div>
  );
}
