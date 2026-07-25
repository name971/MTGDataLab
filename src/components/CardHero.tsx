"use client";

import Image from "next/image";
import { useState } from "react";
import type { CardPrint } from "@/lib/dbCardPrints";
import type { PricePoint } from "@/lib/dbPriceHistory";
import PriceHistoryChart from "./PriceHistoryChart";

// 実物が角丸ではない（角が四角い）ことで知られるセットの一覧。角丸カードかどうかを毎回
// 判定するより、角が四角い方が少数派で既知のセットに限られるため、こちらを列挙する方が楽。
const SQUARE_CORNER_SET_CODES = new Set(["ced", "cei"]);
const VISIBLE_COUNT = 20;

interface DefaultPrint {
  scryfallId: string | null;
  imageUrl: string | null;
  nameEn: string;
  setName: string;
  setCode: string;
  collectorNumber: string;
  rarityLabel: string;
  jpyPrice: number | null;
  usdPrice: number | null;
  usdToJpyRate: number;
  priceExtremesText: string | null;
}

export default function CardHero({
  oracleId,
  defaultPrint,
  defaultEnHistory,
  defaultJaHistory,
  otherPrints,
  pricesByScryfallId,
}: {
  oracleId: string;
  defaultPrint: DefaultPrint;
  defaultEnHistory: PricePoint[];
  defaultJaHistory: PricePoint[];
  otherPrints: CardPrint[];
  pricesByScryfallId: Record<string, number>;
}) {
  const [selected, setSelected] = useState<CardPrint | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function selectPrint(p: CardPrint) {
    setSelected(p);
    setSelectedHistory(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/print-price?scryfallId=${p.scryfallId}`);
      const data = await res.json();
      setSelectedHistory(data.history ?? []);
    } catch {
      setSelectedHistory([]);
    } finally {
      setLoading(false);
    }
  }

  function backToDefault() {
    setSelected(null);
    setSelectedHistory(null);
  }

  const isAlternate = selected !== null;
  const imageUrl = isAlternate ? selected.imageUrl : defaultPrint.imageUrl;
  const setCode = isAlternate ? selected.setCode : defaultPrint.setCode;
  const setName = isAlternate ? selected.setName : defaultPrint.setName;
  const collectorNumber = isAlternate ? selected.collectorNumber : defaultPrint.collectorNumber;
  const jpyPrice = isAlternate ? (pricesByScryfallId[selected.scryfallId] ?? null) : defaultPrint.jpyPrice;
  const enHistory = isAlternate ? (selectedHistory ?? []) : defaultEnHistory;

  const visiblePrints = expanded ? otherPrints : otherPrints.slice(0, VISIBLE_COUNT);

  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-6 sm:flex-row">
          {imageUrl && (
            <Image
              src={imageUrl}
              alt={defaultPrint.nameEn}
              width={223}
              height={311}
              className={`h-fit w-[180px] shrink-0 border border-neutral-200 object-cover ${
                SQUARE_CORNER_SET_CODES.has(setCode) ? "" : "rounded-xl"
              }`}
            />
          )}
          <div className="flex-1">
            {isAlternate ? (
              <>
                <p className="text-sm text-neutral-500">
                  {setName} (#{collectorNumber})
                </p>
                <button
                  onClick={backToDefault}
                  className="mt-1 text-xs text-neutral-400 hover:text-neutral-600 hover:underline"
                >
                  ← 代表プリントの表示に戻る
                </button>
              </>
            ) : (
              <p className="text-sm text-neutral-500">
                {defaultPrint.setName} ・ {defaultPrint.rarityLabel}
              </p>
            )}

            {jpyPrice !== null ? (
              <p className="mt-4 text-2xl font-medium">
                ¥{jpyPrice.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
              </p>
            ) : (
              <p className="mt-4 text-sm text-neutral-500">価格データなし</p>
            )}
            {!isAlternate && defaultPrint.usdPrice !== null && (
              <p className="text-xs text-neutral-400">
                為替換算の参考値（${defaultPrint.usdPrice.toFixed(2)} × {defaultPrint.usdToJpyRate.toFixed(2)}円/$）
              </p>
            )}
            {!isAlternate && defaultPrint.priceExtremesText && (
              <p className="mt-2 whitespace-pre-line text-xs text-neutral-500">
                {defaultPrint.priceExtremesText}
              </p>
            )}
          </div>
        </div>

        {loading ? (
          <p className="py-6 text-center text-xs text-neutral-500">読み込み中...</p>
        ) : (
          <PriceHistoryChart enHistory={enHistory} jaHistory={isAlternate ? [] : defaultJaHistory} />
        )}
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 sm:w-80 sm:shrink-0">
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-neutral-800 px-3 py-2.5 text-white">
          {/* eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG */}
          <img src={`https://svgs.scryfall.io/sets/${setCode}.svg`} alt="" width={22} height={22} className="shrink-0 invert" />
          <div className="min-w-0">
            <p className="truncate text-sm leading-snug font-semibold">
              {setName} ({setCode.toUpperCase()})
            </p>
            <p className="text-xs leading-snug text-neutral-300">
              #{collectorNumber}
              {!isAlternate && ` ・ ${defaultPrint.rarityLabel}`}
            </p>
          </div>
        </div>

        {otherPrints.length > 0 ? (
          <div className="flex flex-col gap-3">
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-auto" />
                <col className="w-20" />
              </colgroup>
              <tbody>
                {visiblePrints.map((p) => {
                  const jpy = pricesByScryfallId[p.scryfallId];
                  return (
                    <tr key={p.scryfallId} className="border-b border-neutral-100 last:border-0">
                      <td className="min-w-0 py-2 pr-2">
                        <button
                          onClick={() => selectPrint(p)}
                          className="flex min-w-0 w-full items-center gap-2 text-left text-neutral-700 hover:underline"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG */}
                          <img
                            src={`https://svgs.scryfall.io/sets/${p.setCode}.svg`}
                            alt=""
                            width={14}
                            height={14}
                            className="shrink-0"
                          />
                          <span className="min-w-0 truncate">{p.setName}</span>
                        </button>
                      </td>
                      <td className="overflow-hidden py-2 text-right text-ellipsis whitespace-nowrap tabular-nums text-neutral-700">
                        {jpy !== undefined ? `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}` : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {otherPrints.length > VISIBLE_COUNT && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="self-center rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:border-neutral-500"
              >
                {expanded ? "閉じる" : `もっと見る（残り${otherPrints.length - VISIBLE_COUNT}件）`}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">他のプリントは見つかりませんでした。</p>
        )}
      </div>
    </div>
  );
}
