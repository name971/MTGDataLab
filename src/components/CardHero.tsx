"use client";

import Image from "next/image";
import { useState } from "react";
import type { CardPrint } from "@/lib/dbCardPrints";
import type { PricePoint } from "@/lib/dbPriceHistory";
import PriceHistoryChart from "./PriceHistoryChart";
import LegalityGrid from "./LegalityGrid";
import ManaText from "./ManaText";

// 実物が角丸ではない（角が四角い）ことで知られるセットの一覧。角丸カードかどうかを毎回
// 判定するより、角が四角い方が少数派で既知のセットに限られるため、こちらを列挙する方が楽。
const SQUARE_CORNER_SET_CODES = new Set(["ced", "cei"]);
const VISIBLE_COUNT = 20;

interface DefaultPrint {
  scryfallId: string | null;
  imageUrl: string | null;
  nameJa: string | null;
  nameEn: string;
  typeLine: string | null;
  manaCost: string | null;
  power: string | null;
  toughness: string | null;
  oracleText: string | null;
  setName: string;
  setCode: string;
  collectorNumber: string;
  rarityLabel: string;
  jpyPrice: number | null;
  jpyPriceFoil: number | null;
  usdPrice: number | null;
  usdPriceFoil: number | null;
  usdToJpyRate: number;
  priceExtremesText: string | null;
  priceExtremesFoilText: string | null;
}

export default function CardHero({
  oracleId,
  defaultPrint,
  defaultEnHistory,
  defaultJaHistory,
  defaultEnFoilHistory,
  defaultJaFoilHistory,
  otherPrints,
  pricesByScryfallId,
  legalities,
}: {
  oracleId: string;
  defaultPrint: DefaultPrint;
  defaultEnHistory: PricePoint[];
  defaultJaHistory: PricePoint[];
  defaultEnFoilHistory: PricePoint[];
  defaultJaFoilHistory: PricePoint[];
  otherPrints: CardPrint[];
  pricesByScryfallId: Record<string, number>;
  legalities: Record<string, string>;
}) {
  // 代表プリントも「一覧の中の1件」として扱い、選ばれているものだけ一覧から外して
  // メイン表示側に出す（クリックすると入れ替わる＝スワップの見た目にする）。
  const defaultAsPrint: CardPrint = {
    scryfallId: defaultPrint.scryfallId ?? "",
    setCode: defaultPrint.setCode,
    setName: defaultPrint.setName,
    collectorNumber: defaultPrint.collectorNumber,
    releasedAt: null,
    imageUrl: defaultPrint.imageUrl,
    notTournamentLegal: false,
  };
  const allPrints = [defaultAsPrint, ...otherPrints];

  const [currentScryfallId, setCurrentScryfallId] = useState(defaultPrint.scryfallId ?? "");
  const [selectedHistory, setSelectedHistory] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [finish, setFinish] = useState<"normal" | "foil">("normal");

  const isAlternate = currentScryfallId !== defaultPrint.scryfallId;
  const current = allPrints.find((p) => p.scryfallId === currentScryfallId) ?? defaultAsPrint;
  const listPrints = allPrints.filter((p) => p.scryfallId !== currentScryfallId);
  const visiblePrints = expanded ? listPrints : listPrints.slice(0, VISIBLE_COUNT);

  const allPrices: Record<string, number> = { ...pricesByScryfallId };
  if (defaultPrint.scryfallId && defaultPrint.jpyPrice !== null) {
    allPrices[defaultPrint.scryfallId] = defaultPrint.jpyPrice;
  }

  async function selectPrint(p: CardPrint) {
    setCurrentScryfallId(p.scryfallId);
    if (p.scryfallId === defaultPrint.scryfallId) {
      setSelectedHistory(null); // 代表プリントに戻る場合はdefaultEnHistoryをそのまま使う
      return;
    }
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

  const enHistory = isAlternate ? (selectedHistory ?? []) : defaultEnHistory;
  // Foilは代表プリントのみ日次追跡している（他プリントの一覧には無い）ため、代表プリント表示中のみ切替可能にする
  const canToggleFoil = !isAlternate && defaultPrint.jpyPriceFoil !== null;
  const effectiveFinish = canToggleFoil ? finish : "normal";
  const jpyPrice = isAlternate
    ? (allPrices[currentScryfallId] ?? null)
    : effectiveFinish === "foil"
      ? defaultPrint.jpyPriceFoil
      : defaultPrint.jpyPrice;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 sm:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-6 sm:flex-row">
          {current.imageUrl && (
            <Image
              src={current.imageUrl}
              alt={defaultPrint.nameEn}
              width={223}
              height={311}
              className={`h-fit w-[180px] shrink-0 border border-neutral-200 object-cover ${
                SQUARE_CORNER_SET_CODES.has(current.setCode) ? "" : "rounded-xl"
              }`}
            />
          )}
          <div className="flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 text-xl font-medium">
                  <span>{defaultPrint.nameJa ?? defaultPrint.nameEn}</span>
                  {defaultPrint.manaCost && (
                    <ManaText text={defaultPrint.manaCost} symbolSize={20} align="middle" />
                  )}
                </p>
                {defaultPrint.nameJa && (
                  <p className="text-sm text-neutral-500">{defaultPrint.nameEn}</p>
                )}
              </div>
              {canToggleFoil && (
                <div className="flex shrink-0 gap-1">
                  {(["normal", "foil"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFinish(f)}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        finish === f
                          ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                          : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                      }`}
                    >
                      {f === "normal" ? "通常" : "Foil"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {defaultPrint.typeLine && (
              <p className="mt-2 text-sm text-neutral-600">{defaultPrint.typeLine}</p>
            )}
            {defaultPrint.oracleText && (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-neutral-700">
                <ManaText text={defaultPrint.oracleText} />
              </p>
            )}
            {defaultPrint.power !== null && defaultPrint.toughness !== null && (
              // 現物のカードはパワー/タフネスがフレーム右下に表示されるため、それに寄せて右揃えにする
              <p className="mt-2 text-right text-sm font-medium text-neutral-700">
                {defaultPrint.power}/{defaultPrint.toughness}
              </p>
            )}

            {isAlternate ? (
              <p className="mt-3 text-sm text-neutral-500">
                {current.setName} (#{current.collectorNumber})
              </p>
            ) : (
              <p className="mt-3 text-sm text-neutral-500">
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
            {/* 為替参考値・最高値/最安値は通常/Foilそれぞれの日次履歴から別々に出す
                （defaultPrint.usdPrice/priceExtremesTextが非Foil用、*Foil系がFoil用）。 */}
            {!isAlternate && effectiveFinish === "normal" && defaultPrint.usdPrice !== null && (
              <p className="text-xs text-neutral-400">
                為替換算の参考値（${defaultPrint.usdPrice.toFixed(2)} × {defaultPrint.usdToJpyRate.toFixed(2)}円/$）
              </p>
            )}
            {!isAlternate && effectiveFinish === "foil" && defaultPrint.usdPriceFoil !== null && (
              <p className="text-xs text-neutral-400">
                為替換算の参考値（${defaultPrint.usdPriceFoil.toFixed(2)} × {defaultPrint.usdToJpyRate.toFixed(2)}円/$）
              </p>
            )}
            {!isAlternate && effectiveFinish === "normal" && defaultPrint.priceExtremesText && (
              <p className="mt-2 whitespace-pre-line text-xs text-neutral-500">
                {defaultPrint.priceExtremesText}
              </p>
            )}
            {!isAlternate && effectiveFinish === "foil" && defaultPrint.priceExtremesFoilText && (
              <p className="mt-2 whitespace-pre-line text-xs text-neutral-500">
                {defaultPrint.priceExtremesFoilText}
              </p>
            )}
          </div>
        </div>

        {loading ? (
          <p className="py-6 text-center text-xs text-neutral-500">読み込み中...</p>
        ) : (
          <PriceHistoryChart
            enHistory={enHistory}
            jaHistory={isAlternate ? [] : defaultJaHistory}
            enFoilHistory={isAlternate ? [] : defaultEnFoilHistory}
            jaFoilHistory={isAlternate ? [] : defaultJaFoilHistory}
            finish={effectiveFinish}
          />
        )}
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 sm:w-80 sm:shrink-0">
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-neutral-800 px-3 py-2.5 text-white">
          {/* eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG */}
          <img
            src={`https://svgs.scryfall.io/sets/${current.setCode}.svg`}
            alt=""
            width={22}
            height={22}
            className="shrink-0 invert"
          />
          <div className="min-w-0">
            <p className="truncate text-sm leading-snug font-semibold">
              {current.setName} ({current.setCode.toUpperCase()})
            </p>
            <p className="text-xs leading-snug text-neutral-300">
              #{current.collectorNumber}
              {!isAlternate && ` ・ ${defaultPrint.rarityLabel}`}
            </p>
          </div>
        </div>
        {current.notTournamentLegal && (
          <p className="mb-3 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
            ※このプリントは特殊な縁/区分のため、どのフォーマットでも使用できません
          </p>
        )}

        {listPrints.length > 0 ? (
          <div className="flex flex-col gap-3">
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-auto" />
                <col className="w-20" />
              </colgroup>
              <tbody>
                {visiblePrints.map((p) => {
                  const jpy = allPrices[p.scryfallId];
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
                          {p.notTournamentLegal && (
                            <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] text-red-700">
                              使用不可
                            </span>
                          )}
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
            {listPrints.length > VISIBLE_COUNT && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="self-center rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:border-neutral-500"
              >
                {expanded ? "閉じる" : `もっと見る（残り${listPrints.length - VISIBLE_COUNT}件）`}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">他のプリントは見つかりませんでした。</p>
        )}
      </div>
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 sm:max-w-md">
        <h2 className="mb-3 text-sm font-medium text-neutral-500">フォーマットリーガル</h2>
        <LegalityGrid legalities={legalities} disabled={current.notTournamentLegal} />
      </div>
    </div>
  );
}
