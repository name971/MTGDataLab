import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCardPrintByScryfallId } from "@/lib/dbCardPrints";
import { supabase } from "@/lib/supabase";
import { fetchPriceByScryfallId } from "@/lib/cardData";
import { fetchExchangeRates, toJpy, formatJpy } from "@/lib/fx";

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

  const [print, oracleRes, rates] = await Promise.all([
    getCardPrintByScryfallId(scryfallId),
    supabase.from("card_oracles").select("name, printed_name_ja").eq("oracle_id", oracleId).maybeSingle(),
    fetchExchangeRates(),
  ]);
  if (!print || print.scryfallId !== scryfallId) notFound();

  const oracle = oracleRes.data;
  const nameJa = oracle?.printed_name_ja ?? null;
  const nameEn = oracle?.name ?? "";

  // このプリント固有の価格はDBで追跡していない（代表プリントのみ日次スナップショット対象、
  // db/schema.sql 8章参照）ため、このページを開いたときだけ1件ライブ取得する
  // （一覧側は price を持たずAPIも呼ばない。個別ページ限定の軽量な例外）。
  const livePrice = await fetchPriceByScryfallId(print.scryfallId);
  const usdPrice = livePrice?.usd ? parseFloat(livePrice.usd) : null;
  const jpyPrice = usdPrice !== null ? toJpy(usdPrice, rates.usdToJpy) : null;

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
                <p className="text-xs text-neutral-400">
                  為替換算の参考値（${usdPrice?.toFixed(2)} × {rates.usdToJpy.toFixed(2)}円/$）
                </p>
              </>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">価格データなし</p>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              ※このプリント固有の価格は日次履歴を保持していません（表示のたびに取得した現在値です）
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
