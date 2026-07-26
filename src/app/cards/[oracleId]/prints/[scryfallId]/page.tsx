import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCardPrintByScryfallId } from "@/lib/dbCardPrints";
import { getPrintPriceHistory } from "@/lib/dbCardPrintPrices";
import { supabase } from "@/lib/supabase";
import { formatJpy } from "@/lib/fx";
import PriceHistoryChart from "@/components/PriceHistoryChart";

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

  const [print, oracleRes, priceHistory] = await Promise.all([
    getCardPrintByScryfallId(scryfallId),
    supabase.from("card_oracles").select("name, printed_name_ja").eq("oracle_id", oracleId).maybeSingle(),
    getPrintPriceHistory(scryfallId),
  ]);
  if (!print || print.scryfallId !== scryfallId) notFound();

  const oracle = oracleRes.data;
  const nameJa = oracle?.printed_name_ja ?? null;
  const nameEn = oracle?.name ?? "";

  // card_print_prices（scripts/snapshot-print-prices.mjsが日次で追記、db/schema.sql参照）の
  // 最新日を「現在価格」として表示する。まだ一度もスナップショットが無い場合は価格データなし。
  const latest = priceHistory.at(-1) ?? null;
  const jpyPrice = latest?.jpy ?? null;

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
            <p className="text-xl font-medium">{nameJa ?? nameEn}</p>
            {nameJa && <p className="text-sm text-neutral-500">{nameEn}</p>}
            <p className="mt-2 text-sm text-neutral-500">
              {print.setName}（#{print.collectorNumber}）
            </p>
            {print.releasedAt && (
              <p className="text-sm text-neutral-500">発売日: {formatDateSlash(print.releasedAt)}</p>
            )}
            {jpyPrice !== null ? (
              <>
                <p className="mt-4 text-2xl font-medium">{formatJpy(jpyPrice)}</p>
                <p className="text-xs text-neutral-400">{latest?.date}時点の参考値</p>
              </>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">価格データなし</p>
            )}
          </div>
        </div>
      </div>

      {priceHistory.length > 0 && (
        <PriceHistoryChart
          enHistory={priceHistory}
          jaHistory={[]}
          enFoilHistory={[]}
          jaFoilHistory={[]}
          finish="normal"
        />
      )}
    </div>
  );
}
