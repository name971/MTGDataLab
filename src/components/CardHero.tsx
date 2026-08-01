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

/** "2026-07-25" -> "2026/7/25" */
function formatDateSlash(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

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
  usdToJpyRateFoil: number;
  priceExtremesText: string | null;
  priceExtremesFoilText: string | null;
}

export default function CardHero({
  oracleId,
  defaultPrint,
  defaultEnHistory,
  defaultEnFoilHistory,
  otherPrints,
  pricesByScryfallId,
  foilPricesByScryfallId,
  legalities,
}: {
  oracleId: string;
  defaultPrint: DefaultPrint;
  defaultEnHistory: PricePoint[];
  defaultEnFoilHistory: PricePoint[];
  otherPrints: CardPrint[];
  pricesByScryfallId: Record<string, number>;
  foilPricesByScryfallId: Record<string, number>;
  legalities: Record<string, string>;
}) {
  // カードデータ（このページの主役プリント）も「一覧の中の1件」として扱い、選ばれているものだけ
  // 一覧の先頭に出す（クリックすると画像・価格がその場で入れ替わる＝スワップの見た目にする）。
  const defaultAsPrint: CardPrint = {
    scryfallId: defaultPrint.scryfallId ?? "",
    setCode: defaultPrint.setCode,
    setName: defaultPrint.setName,
    collectorNumber: defaultPrint.collectorNumber,
    releasedAt: null,
    imageUrl: defaultPrint.imageUrl,
    notTournamentLegal: false,
    rarity: null,
  };
  const allPrints = [defaultAsPrint, ...otherPrints];

  const [currentScryfallId, setCurrentScryfallId] = useState(defaultPrint.scryfallId ?? "");
  // 「カードデータ」＝全プリント中の最安値（毎日どのプリントが最安かは変わりうる集約値）と、
  // 「特定のプリント自身の値動き」は別物。currentScryfallIdがdefaultPrint.scryfallIdと
  // 一致していても、それが「今日たまたま最安だったから」なのか「そのプリントを個別に
  // 選んだから」なのかを区別する必要があるため、scryfallIdの一致では判定せず専用のstateを持つ。
  const [isAggregateView, setIsAggregateView] = useState(true);
  const [selectedHistory, setSelectedHistory] = useState<PricePoint[] | null>(null);
  const [selectedFoilHistory, setSelectedFoilHistory] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [finish, setFinish] = useState<"normal" | "foil">("normal");

  const isAlternate = !isAggregateView;
  const current = allPrints.find((p) => p.scryfallId === currentScryfallId) ?? defaultAsPrint;
  const listPrints = allPrints.filter((p) => p.scryfallId !== currentScryfallId);
  const visiblePrints = expanded ? listPrints : listPrints.slice(0, VISIBLE_COUNT);

  const allPrices: Record<string, number> = { ...pricesByScryfallId };
  if (defaultPrint.scryfallId && defaultPrint.jpyPrice !== null) {
    allPrices[defaultPrint.scryfallId] = defaultPrint.jpyPrice;
  }
  // otherPrintsにはカードデータ自身のプリントが含まれないため、foilPricesByScryfallIdにも
  // その分が無い。ここで補っておかないと、一覧でカードデータの行だけFoil価格が
  // 表示されない（allPricesと同じ理由・同じ対応）。
  const allFoilPrices: Record<string, number> = { ...foilPricesByScryfallId };
  if (defaultPrint.scryfallId && defaultPrint.jpyPriceFoil !== null) {
    allFoilPrices[defaultPrint.scryfallId] = defaultPrint.jpyPriceFoil;
  }

  // 特定のプリントを選ぶ（defaultPrintと同じscryfallIdであっても、常にそのプリント自身の
  // 価格推移をAPIから取得する＝集約値と混同しない）。
  async function selectPrint(p: CardPrint) {
    setCurrentScryfallId(p.scryfallId);
    setIsAggregateView(false);
    setFinish("normal"); // プリントを切り替えたら表示は通常価格から始める
    setSelectedHistory(null);
    setSelectedFoilHistory(null);
    setLoading(true);
    try {
      const [normalRes, foilRes] = await Promise.all([
        fetch(`/api/print-price?scryfallId=${p.scryfallId}`),
        fetch(`/api/print-price?scryfallId=${p.scryfallId}&finish=foil`),
      ]);
      const [normalData, foilData] = await Promise.all([normalRes.json(), foilRes.json()]);
      setSelectedHistory(normalData.history ?? []);
      setSelectedFoilHistory(foilData.history ?? []);
    } catch {
      setSelectedHistory([]);
      setSelectedFoilHistory([]);
    } finally {
      setLoading(false);
    }
  }

  /** 「カードデータ」＝全プリント中の最安値（集約）の表示に戻す */
  function resetToAggregate() {
    setCurrentScryfallId(defaultPrint.scryfallId ?? "");
    setIsAggregateView(true);
    setFinish("normal");
    setSelectedHistory(null);
    setSelectedFoilHistory(null);
  }

  const enHistory = isAlternate ? (selectedHistory ?? []) : defaultEnHistory;
  const enFoilHistoryForChart = isAlternate ? (selectedFoilHistory ?? []) : defaultEnFoilHistory;
  // 通常・Foil両方の価格が実際にある時だけ切り替えタブを出す。片方しか無いプリント
  // （Foil専用プロモ等）はタブを出さず、存在する方をそのまま表示する。
  const hasNormalPrice = isAlternate
    ? allPrices[currentScryfallId] !== undefined
    : defaultPrint.jpyPrice !== null;
  const hasFoilPrice = isAlternate
    ? allFoilPrices[currentScryfallId] !== undefined
    : defaultPrint.jpyPriceFoil !== null;
  const canToggleFoil = hasNormalPrice && hasFoilPrice;
  const effectiveFinish = canToggleFoil ? finish : hasFoilPrice ? "foil" : "normal";
  const jpyPrice = isAlternate
    ? effectiveFinish === "foil"
      ? (allFoilPrices[currentScryfallId] ?? null)
      : (allPrices[currentScryfallId] ?? null)
    : effectiveFinish === "foil"
      ? defaultPrint.jpyPriceFoil
      : defaultPrint.jpyPrice;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-6 sm:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-6 sm:flex-row">
          {current.imageUrl && (
            <div className="w-[180px] shrink-0">
              {isAlternate ? (
                <button
                  onClick={resetToAggregate}
                  className="mb-1.5 inline-block rounded bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-white hover:bg-neutral-700"
                >
                  ← カードデータに戻る
                </button>
              ) : (
                <span
                  title="カード名・画像はこのプリントのものを表示しています（トーナメントで使える通常のプリントの中で最安値のものを自動選択、プロモ・特殊枠・コラボ作品限定版などは対象外）。価格は全プリント中の最安値を表示しています"
                  className="mb-1.5 inline-block cursor-help rounded bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-white"
                >
                  カードデータ
                </span>
              )}
              <div
                className={`relative h-fit w-full overflow-hidden border border-neutral-200 ${
                  SQUARE_CORNER_SET_CODES.has(current.setCode) ? "" : "rounded-xl"
                }`}
              >
              <Image
                src={current.imageUrl}
                alt={defaultPrint.nameEn}
                width={223}
                height={311}
                className="h-fit w-full object-cover"
              />
              {effectiveFinish === "foil" && (
                // Foil選択中であることが一目で分かるよう、虹色のホログラム風テクスチャを
                // 半透明で重ねる（実物のFoilカードの質感を模した演出。クリックは透過させる）。
                <div
                  className="pointer-events-none absolute inset-0 opacity-50 mix-blend-overlay"
                  style={{
                    background:
                      "repeating-linear-gradient(115deg, #ff0080 0%, #ff8c00 14%, #ffed00 28%, #00ff8c 42%, #00c8ff 56%, #8c00ff 70%, #ff0080 84%)",
                    backgroundSize: "200% 200%",
                  }}
                />
              )}
              </div>
            </div>
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
              {(hasNormalPrice || hasFoilPrice) && (
                <div className="flex shrink-0 items-center gap-1">
                  {(["normal", "foil"] as const).map((f) => {
                    const available = f === "normal" ? hasNormalPrice : hasFoilPrice;
                    if (f === "foil") {
                      // タブの形・文字色・枠線は「通常」タブと完全に揃え、中の塗りつぶしだけ
                      // 虹色にしてFoilらしさを出す。
                      return (
                        <button
                          key={f}
                          onClick={() => available && setFinish(f)}
                          disabled={!available}
                          className={`relative rounded-md border px-2 py-1 text-xs ${
                            !available
                              ? "cursor-not-allowed border-neutral-200 text-neutral-300 opacity-50 grayscale"
                              : effectiveFinish === "foil"
                                ? "border-neutral-500 text-neutral-900"
                                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                          }`}
                          style={{
                            background:
                              "linear-gradient(115deg, #ff008033, #ff8c0033, #ffed0033, #00ff8c33, #00c8ff33, #8c00ff33)",
                          }}
                        >
                          Foil
                          {!available && (
                            <svg
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              className="pointer-events-none absolute inset-0 h-full w-full text-neutral-700"
                            >
                              <line x1="4" y1="4" x2="96" y2="96" stroke="currentColor" strokeWidth="4" />
                              <line x1="96" y1="4" x2="4" y2="96" stroke="currentColor" strokeWidth="4" />
                            </svg>
                          )}
                        </button>
                      );
                    }
                    return (
                      <button
                        key={f}
                        onClick={() => available && setFinish(f)}
                        disabled={!available}
                        className={`relative rounded-md border px-2 py-1 text-xs ${
                          !available
                            ? "cursor-not-allowed border-neutral-200 text-neutral-300"
                            : effectiveFinish === f
                              ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                              : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                        }`}
                      >
                        通常
                        {!available && (
                          // ボタンの枠全体に対角線のバツ印を重ねて「この選択肢自体が存在しない」ことを見せる
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            className="pointer-events-none absolute inset-0 h-full w-full text-neutral-300"
                          >
                            <line x1="4" y1="4" x2="96" y2="96" stroke="currentColor" strokeWidth="4" />
                            <line x1="96" y1="4" x2="4" y2="96" stroke="currentColor" strokeWidth="4" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
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
                {current.releasedAt && ` ・ 発売日: ${formatDateSlash(current.releasedAt)}`}
              </p>
            ) : (
              // 「カードデータ」は特定の1プリントではなく集約値の表示なので、セット名（代表プリントの
              // セット、Mystery Booster等の再録専用商品になることがあり紛らわしい）は出さずレアリティのみ表示する
              <p className="mt-3 text-sm text-neutral-500">{defaultPrint.rarityLabel}</p>
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
            {!isAlternate && effectiveFinish === "normal" && defaultPrint.usdPrice !== null && defaultPrint.jpyPrice !== null && (
              <p className="text-xs text-neutral-400">
                為替換算の参考値（${defaultPrint.usdPrice.toFixed(2)} × {defaultPrint.usdToJpyRate.toFixed(2)}円/$）
              </p>
            )}
            {!isAlternate && effectiveFinish === "foil" && defaultPrint.usdPriceFoil !== null && defaultPrint.jpyPriceFoil !== null && (
              <p className="text-xs text-neutral-400">
                為替換算の参考値（${defaultPrint.usdPriceFoil.toFixed(2)} × {defaultPrint.usdToJpyRateFoil.toFixed(2)}円/$）
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
            enFoilHistory={enFoilHistoryForChart}
            finish={effectiveFinish}
          />
        )}
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 sm:w-80 sm:shrink-0">
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-neutral-800 px-3 py-2.5 text-white">
          {isAlternate ? (
            // eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG
            <img
              src={`https://svgs.scryfall.io/sets/${current.setCode}.svg`}
              alt=""
              width={22}
              height={22}
              className="shrink-0 invert"
              // Scryfallにアイコンが無いセット（GK1等の一部）だとブラウザ標準の壊れた画像アイコンが
              // 出てしまうため、読み込み失敗時は非表示にする
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : (
            // 「カードデータ」は特定の1セットに属さない集約表示なので、Scryfallのセットアイコンでは
            // なく自前のアイコン（複数プリントを重ねたイラスト）を使う
            // eslint-disable-next-line @next/next/no-img-element -- 自前の静的SVG、next/imageの最適化不要
            <img src="/icons/all-prints.svg" alt="" width={22} height={22} className="shrink-0" />
          )}
          <div className="min-w-0">
            {isAlternate ? (
              <>
                <p className="truncate text-sm leading-snug font-semibold">
                  {current.setName} ({current.setCode.toUpperCase()})
                </p>
                <p className="text-xs leading-snug text-neutral-300">#{current.collectorNumber}</p>
              </>
            ) : (
              // 「カードデータ」は特定の1プリントではなく全プリント集約の表示なので、
              // 代表プリント1件のセット名・コレクター番号ではなく、プリント総数とレアリティ集約を出す
              <>
                <p className="truncate text-sm leading-snug font-semibold">全{allPrints.length}種のプリント</p>
                <p className="text-xs leading-snug text-neutral-300">{defaultPrint.rarityLabel}</p>
              </>
            )}
          </div>
        </div>
        {current.notTournamentLegal && (
          <p className="mb-3 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
            ※このプリントは特殊なため、公式大会では使用できません
          </p>
        )}

        {allPrints.length > 0 && (
          <div className="flex flex-col gap-3">
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-auto" />
                <col className="w-20" />
              </colgroup>
              <tbody>
                {/* カードデータも一覧の中の1件として常に先頭に表示する（他プリントと並べて
                    見比べられるように）。URLは変えず、他の行と同じselectPrintでその場の表示
                    （画像・価格・下のセット情報行）を切り替える。 */}
                <tr className="border-b border-neutral-100 bg-neutral-50 last:border-0">
                  <td className="min-w-0 py-2 pr-2">
                    <button
                      onClick={() => selectPrint(defaultAsPrint)}
                      className="flex min-w-0 w-full items-center gap-2 text-left text-neutral-900 hover:underline"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG */}
                      <img
                        src={`https://svgs.scryfall.io/sets/${current.setCode}.svg`}
                        alt=""
                        width={14}
                        height={14}
                        className="shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                      <span className="min-w-0 truncate font-semibold">{current.setName}</span>
                      {current.notTournamentLegal && (
                        <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] text-red-700">使用不可</span>
                      )}
                    </button>
                  </td>
                  <td className="overflow-hidden py-2 text-right text-ellipsis whitespace-nowrap tabular-nums text-neutral-900">
                    <p>
                      {allPrices[current.scryfallId] !== undefined
                        ? `¥${allPrices[current.scryfallId].toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`
                        : "-"}
                    </p>
                    {allFoilPrices[current.scryfallId] !== undefined && (
                      <p className="text-[10px] text-neutral-400">
                        Foil ¥
                        {allFoilPrices[current.scryfallId].toLocaleString("ja-JP", {
                          maximumFractionDigits: 0,
                        })}
                      </p>
                    )}
                  </td>
                </tr>
                {visiblePrints.map((p) => {
                  const jpy = allPrices[p.scryfallId];
                  const jpyFoil = allFoilPrices[p.scryfallId];
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
                            onError={(e) => {
                              e.currentTarget.style.visibility = "hidden";
                            }}
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
                        <p>{jpy !== undefined ? `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}` : "-"}</p>
                        {jpyFoil !== undefined && (
                          <p className="text-[10px] text-neutral-400">
                            Foil ¥{jpyFoil.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                          </p>
                        )}
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
