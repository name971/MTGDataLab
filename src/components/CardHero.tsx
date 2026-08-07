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

const FOIL_GRADIENT_STOPS = (
  <>
    <stop offset="0%" stopColor="#ff0080" />
    <stop offset="16%" stopColor="#ff8c00" />
    <stop offset="32%" stopColor="#ffed00" />
    <stop offset="48%" stopColor="#00ff8c" />
    <stop offset="64%" stopColor="#00c8ff" />
    <stop offset="80%" stopColor="#8c00ff" />
    <stop offset="100%" stopColor="#ff0080" />
  </>
);

/** 一覧のFoil/通常価格切り替えボタンのアイコン。案比較用に3種類実装している（DESIGN定数で切り替え）。 */
function FoilToggleIcon({ active, variant }: { active: boolean; variant: "sparkle" | "switch" | "cards" }) {
  const gradId = `foilToggleGrad-${variant}`;
  const stroke = active ? `url(#${gradId})` : "currentColor";
  const fill = active ? `url(#${gradId})` : "currentColor";
  const colorClass = active ? "" : "text-neutral-400";

  if (variant === "sparkle") {
    // ON時は星自体には色を付けず、輪郭だけにしてボタン背景の虹色ウォッシュを中から透かして見せる。
    // 輪郭の色はカード名横の「Foil」タブがON時に使う色（border-neutral-500・text-neutral-900）に揃える
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="inline-block align-[-2px]">
        <path
          d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2z"
          fill={active ? "none" : "currentColor"}
          stroke={active ? "currentColor" : "none"}
          strokeWidth={active ? 1.3 : 0}
          strokeLinejoin="round"
          className={active ? "text-neutral-900" : colorClass}
        />
        <path
          d="M19 15l0.9 2.1L22 18l-2.1 0.9L19 21l-0.9-2.1L16 18l2.1-0.9L19 15z"
          fill={active ? "none" : "currentColor"}
          stroke={active ? "currentColor" : "none"}
          strokeWidth={active ? 1.1 : 0}
          strokeLinejoin="round"
          className={active ? "text-neutral-900" : colorClass}
        />
      </svg>
    );
  }

  if (variant === "switch") {
    return (
      <svg width="22" height="13" viewBox="0 0 34 20" fill="none" className="inline-block align-[-3px]">
        {active && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              {FOIL_GRADIENT_STOPS}
            </linearGradient>
          </defs>
        )}
        <rect
          x="1"
          y="1"
          width="32"
          height="18"
          rx="9"
          stroke="currentColor"
          strokeWidth="2"
          className="text-neutral-300"
        />
        <circle cx={active ? 25 : 9} cy="10" r="6" fill={fill} className={colorClass} />
      </svg>
    );
  }

  // variant === "cards"
  return (
    <svg width="16" height="14" viewBox="0 0 24 22" fill="none" className="inline-block align-[-2px]">
      {active && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            {FOIL_GRADIENT_STOPS}
          </linearGradient>
        </defs>
      )}
      <rect x="2" y="3" width="13" height="17" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-neutral-300" />
      <rect
        x="9"
        y="1"
        width="13"
        height="17"
        rx="1.5"
        fill={active ? fill : "white"}
        className={active ? "" : "text-neutral-100"}
        stroke={stroke}
        strokeWidth="1.5"
      />
    </svg>
  );
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
  // card_prints未反映など、otherPrintsに代表プリント自身の行がまだ無い場合の最終フォールバック用
  // （currentの解決・resetToAggregateの画像表示に使う。通常はotherPrintsに実プリントとして
  // 含まれているため、下のallPrintsには二重登録しない）。
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
  const allPrints = otherPrints.some((p) => p.scryfallId === defaultAsPrint.scryfallId)
    ? otherPrints
    : [defaultAsPrint, ...otherPrints];

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
  const [printSortKey, setPrintSortKey] = useState<"releaseDate" | "price">("releaseDate");
  // 発売日順のデフォルトは新しい順（サーバー側のクエリと合わせる）、価格順のデフォルトは安い順。
  // 同じボタンをもう一度押すと逆順に切り替わる。
  const [printSortDir, setPrintSortDir] = useState<"asc" | "desc">("desc");
  // Foil価格で一覧を見るモード。ON中は価格順ソート・各行の価格表示（太字/小さい文字）がFoil基準になる。
  // メインのカード表示（画像・現在価格、finish）とは独立しており、切り替えても連動しない。
  const [listSortFoil, setListSortFoil] = useState(false);

  function clickSort(key: "releaseDate" | "price") {
    if (printSortKey === key) {
      setPrintSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setPrintSortKey(key);
      setPrintSortDir(key === "price" ? "asc" : "desc");
    }
  }

  const isAlternate = !isAggregateView;
  const current = allPrints.find((p) => p.scryfallId === currentScryfallId) ?? defaultAsPrint;
  // 集約表示（カードデータ）中は、たまたまcurrentが指すプリント自身の画像ではなく、
  // getBestCardImageで選んだ画像（defaultPrint.imageUrl、安い順+日本語版一致）を必ず使う。
  // currentScryfallIdが代表プリントと一致していても、それはcard_printsの実プリント行を
  // 指しているだけで、そのプリント自身の画像（日本語版が無ければ英語版）とは限らない。
  const mainImageUrl = isAlternate ? current.imageUrl : defaultPrint.imageUrl;

  // otherPrintsは代表プリント自身も含む全プリントなので、各行の価格はpricesByScryfallId/
  // foilPricesByScryfallId（プリント自身の実勢価格）をそのまま使う。以前はここでdefaultPrint.jpyPrice
  // （全プリント中の最安値＝集約値）を代表プリントの行に上書きしていたが、集約値の最安プリントが
  // 代表プリントと別の日には、代表プリントの行に他プリントの価格が出てしまう不整合があったため廃止。
  const allPrices: Record<string, number> = pricesByScryfallId;
  const allFoilPrices: Record<string, number> = foilPricesByScryfallId;

  // 一覧の並び順。発売日順・価格順どちらも選べ、同じボタンをもう一度押すと逆順になる。
  // listSortFoil中は価格順の基準がFoil価格になる。
  const priceSortSource = listSortFoil ? allFoilPrices : allPrices;
  const listPrints = [...otherPrints].sort((a, b) => {
    if (printSortKey === "price") {
      const priceA = priceSortSource[a.scryfallId];
      const priceB = priceSortSource[b.scryfallId];
      if (priceA === undefined && priceB === undefined) return 0;
      if (priceA === undefined) return 1; // 価格不明は順序に関わらず常に末尾
      if (priceB === undefined) return -1;
      return printSortDir === "asc" ? priceA - priceB : priceB - priceA;
    }
    const cmp = (a.releasedAt ?? "").localeCompare(b.releasedAt ?? ""); // 昇順基準（古い→新しい）
    return printSortDir === "asc" ? cmp : -cmp;
  });
  const visiblePrints = expanded ? listPrints : listPrints.slice(0, VISIBLE_COUNT);

  // 特定のプリントを選ぶ（defaultPrintと同じscryfallIdであっても、常にそのプリント自身の
  // 価格推移をAPIから取得する＝集約値と混同しない）。
  async function selectPrint(p: CardPrint) {
    setCurrentScryfallId(p.scryfallId);
    setIsAggregateView(false);
    // Foil価格で一覧を見ているとき（listSortFoil）は、選んだプリントにFoil価格がある限り
    // Foil表示のまま遷移する。無ければ通常価格にフォールバックする。
    setFinish(listSortFoil && allFoilPrices[p.scryfallId] !== undefined ? "foil" : "normal");
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
          {mainImageUrl && (
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
                src={mainImageUrl}
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

        {otherPrints.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-neutral-400">並び順:</span>
              {(
                [
                  { key: "releaseDate", label: "発売日順" },
                  { key: "price", label: "価格順" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => clickSort(opt.key)}
                  className={`rounded-md border px-2 py-0.5 ${
                    printSortKey === opt.key
                      ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                      : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                  }`}
                >
                  {opt.label}
                  {printSortKey === opt.key && (printSortDir === "asc" ? " ▲" : " ▼")}
                </button>
              ))}
              <button
                onClick={() => setListSortFoil((v) => !v)}
                title={listSortFoil ? "通常価格で見る" : "Foil価格で見る"}
                aria-label={listSortFoil ? "通常価格で見る" : "Foil価格で見る"}
                aria-pressed={listSortFoil}
                className={`ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                  listSortFoil ? "border-neutral-500" : "border-neutral-300 hover:border-neutral-500"
                }`}
                style={
                  listSortFoil
                    ? {
                        // 「Foil」タブと同じ虹色（アルファ付き）を円の背景にも敷いて、
                        // アイコンだけでなくボタン全体でFoilっぽさが一目で伝わるようにする
                        background:
                          "linear-gradient(115deg, #ff008033, #ff8c0033, #ffed0033, #00ff8c33, #00c8ff33, #8c00ff33)",
                      }
                    : undefined
                }
              >
                <FoilToggleIcon active={listSortFoil} variant="sparkle" />
              </button>
            </div>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-auto" />
                <col className="w-20" />
              </colgroup>
              <tbody>
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
                      <td className="overflow-hidden py-2 text-right tabular-nums text-neutral-700">
                        {/* 行の並び・行数は常に固定（通常行が上、Foil行が下）にし、切り替えボタンでは
                            太字/小さい文字のスタイルだけを入れ替える。値が無い方は"-"を出して行数を
                            揃えることで、切り替え時に他の行のテキストや高さがずれないようにしている。
                            overflow/text-ellipsis/whitespace-nowrapはtdに付けても子のpに継承されないため、
                            各pに個別に付ける（付け忘れると長い金額が折り返して行の高さが伸びてしまう） */}
                        <p
                          className={`overflow-hidden text-ellipsis whitespace-nowrap ${
                            listSortFoil ? "text-[10px] text-neutral-400" : ""
                          }`}
                        >
                          {jpy !== undefined ? `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}` : "-"}
                        </p>
                        <p
                          className={`overflow-hidden text-ellipsis whitespace-nowrap ${
                            listSortFoil ? "" : "text-[10px] text-neutral-400"
                          }`}
                        >
                          {jpyFoil !== undefined
                            ? `Foil ¥${jpyFoil.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`
                            : "Foil -"}
                        </p>
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
