import Image from "next/image";
import Link from "next/link";
import { FORMATS, formatLabelJa, type Format } from "@/lib/formats";
import { COLOR_ORDER } from "@/lib/manaColors";
import {
  getBannedCardsByYear,
  getCurrentlyBannedCards,
  getReservedListCards,
  type BannedCardWithCard,
} from "@/lib/dbBannedCards";

// 色フィルタの選択肢。"C"は無色（mana_costにWUBRGどれも含まれないカード）を表す特別扱いで、
// COLOR_ORDER（W/U/B/R/G）そのものには含まれない。
const COLOR_FILTER_OPTIONS = [...COLOR_ORDER, "C"] as const;
type ColorFilter = (typeof COLOR_FILTER_OPTIONS)[number];

function isColorFilter(v: string): v is ColorFilter {
  return (COLOR_FILTER_OPTIONS as readonly string[]).includes(v);
}

function parseColors(v: string | undefined): ColorFilter[] {
  if (!v) return [];
  return v.split(",").filter(isColorFilter);
}

/** cardのcolorsが指定の色フィルタ集合に一致するか（フィルタ未選択なら常に一致） */
function matchesColorFilter(cardColors: string[], selected: ColorFilter[]): boolean {
  if (selected.length === 0) return true;
  if (cardColors.length === 0) return selected.includes("C");
  return cardColors.some((c) => selected.includes(c as ColorFilter));
}

function ColorFilterRow({ selected, buildColorHref }: { selected: ColorFilter[]; buildColorHref: (colors: ColorFilter[]) => string }) {
  const toggle = (c: ColorFilter) => (selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {COLOR_ORDER.map((c) => (
        <Link
          key={c}
          href={buildColorHref(toggle(c))}
          aria-pressed={selected.includes(c)}
          className={`rounded-full p-0.5 ${selected.includes(c) ? "bg-neutral-200 ring-2 ring-neutral-400" : "opacity-50 hover:opacity-100"}`}
        >
          <Image src={`/mana/${c}.svg`} alt={c} width={22} height={22} className="h-[22px] w-[22px]" />
        </Link>
      ))}
      <Link
        href={buildColorHref(toggle("C"))}
        aria-pressed={selected.includes("C")}
        className={`rounded-full border px-2 py-0.5 text-xs ${
          selected.includes("C")
            ? "border-neutral-500 bg-neutral-200 text-neutral-900"
            : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
        }`}
      >
        無色
      </Link>
      {selected.length > 0 && (
        <Link href={buildColorHref([])} className="text-xs text-neutral-400 underline hover:text-neutral-600">
          クリア
        </Link>
      )}
    </div>
  );
}

export const metadata = { title: "禁止カード - MTG DataLab" };

// 禁止カード自体の追加頻度は低い（bannedCards.tsの手動更新・legalities/is_reservedも
// 日次バッチ更新止まり）ため、長めのキャッシュで十分
export const revalidate = 21600;

const TABS = [
  { key: "current", label: "禁止カード" },
  { key: "history", label: "歴代禁止カード" },
  { key: "reserved", label: "再録禁止カード" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function isTab(v: string | undefined): v is TabKey {
  return (TABS.map((t) => t.key) as string[]).includes(v ?? "");
}

function isFormat(v: string | undefined): v is Format {
  return (FORMATS as readonly string[]).includes(v ?? "");
}

function buildHref(
  tab: TabKey,
  format: Format,
  sortDir: "asc" | "desc",
  fillGaps: boolean,
  view: "list" | "compact",
  overrides: Partial<{ tab: TabKey; format: Format; sortDir: "asc" | "desc"; fillGaps: boolean; view: "list" | "compact" }>,
): string {
  const next = { tab, format, sortDir, fillGaps, view, ...overrides };
  const params = new URLSearchParams();
  if (next.tab !== "current") params.set("tab", next.tab);
  if (next.format !== "Standard") params.set("format", next.format);
  if (next.sortDir !== "desc") params.set("sort", next.sortDir);
  if (next.fillGaps) params.set("fillGaps", "1");
  if (next.view !== "list") params.set("view", next.view);
  const qs = params.toString();
  return qs ? `/banned-cards?${qs}` : "/banned-cards";
}

function cardTitle(card: BannedCardWithCard): string {
  const label = card.status === "restricted" ? "制限" : "禁止";
  return `${card.nameJa ?? card.name}${card.month ? ` (${card.year}年${card.month}月${label})` : ""}`;
}

// このページのサムネイルは最大でも90px高（コンパクト表示では46px高まで縮む）にしか表示しない
// のに、DBに保存されているのは488x680の"normal"画像（next.config.tsでimages.unoptimized=true
// にしているため、next/imageによる自動リサイズも効かず、そのまま丸ごとダウンロードされる）。
// ScryfallのCDN URLは/normal/を/small/に置き換えるだけで146x204版が同じUUIDで取得できるため、
// このページ専用にDBスキーマを変えずサムネイルだけ差し替える（歴代分で数百枚あり、
// 1年分でも数MB→数百KB程度まで転送量を落とせる）。
function toSmallImageUrl(url: string): string {
  return url.replace("/normal/", "/small/");
}

// カード画像の縦横比（通常のカード比率）。next/imageのwidth/heightは実画像取得用のヒントとして
// 固定値64x90を渡しつつ、実際の表示サイズはstyleのheight（CSS式もしくは数値px）で決める。
function CardThumb({ card, heightStyle }: { card: BannedCardWithCard; heightStyle: string }) {
  const borderClass = card.status === "restricted" ? "border-amber-500" : "border-neutral-200";
  return (
    <Link
      key={card.oracleId}
      href={`/cards/${card.oracleId}`}
      className="group relative block shrink-0 hover:z-20"
      title={cardTitle(card)}
    >
      {card.imageUrl ? (
        <Image
          src={toSmallImageUrl(card.imageUrl)}
          alt={card.nameJa ?? card.name}
          width={64}
          height={90}
          className={`rounded-sm border group-hover:border-neutral-500 ${borderClass}`}
          style={{ height: heightStyle, width: "auto" }}
        />
      ) : (
        <div
          className={`flex items-center justify-center overflow-hidden rounded-sm border bg-neutral-100 text-center text-[8px] text-neutral-400 ${borderClass}`}
          style={{ height: heightStyle, aspectRatio: "64 / 90" }}
        >
          {card.nameJa ?? card.name}
        </div>
      )}
      {card.status === "restricted" && (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 rounded-full bg-amber-500 px-0.5 text-[6px] leading-tight font-bold text-white shadow">
          制限
        </span>
      )}
    </Link>
  );
}

// リスト表示のカードサイズ（固定）
const LIST_CARD_HEIGHT_PX = "90px";

// コンパクト表示（1画面で見る）: カード1枚の高さをCSSのdvh単位で計算し、実際のブラウザの
// 画面高さに応じて自動で決まるようにする（サーバー側でpx数を決め打ちすると実機の画面高さと
// 合わず、縦を使い切れなかったり逆にはみ出したりしたため）。
// - ヘッダー・タイトル・操作ボタン・凡例・軸ラベル・列下部のラベル分をHEADER_RESERVE_PXとして
//   固定px（実測225px+ラベル・余白分）で差し引く。この分はビューポートの高さによらずほぼ
//   一定なので、vh単位ではなく固定pxにする（vhにすると小さい画面で相対的に少なく確保されすぎて
//   はみ出してしまっていた）。
// - 最も枚数が多い列のカードがちょうどこの高さに収まるよう、残り高さを枚数で割る。
// - clamp()で下限（判別できるギリギリの大きさ）と上限（リスト表示と同じ通常サイズ）を設ける。
const HEADER_RESERVE_PX = 300;
const CARD_MIN_HEIGHT_PX = 46;
const CARD_MAX_HEIGHT_PX = 90;
const CARD_GAP_PX = 4; // 列内のカード間の隙間（gap-1）。枚数が多い列だと合計が無視できない大きさになる

function compactHeightStyle(cardsPerColumn: number): string {
  const gapTotalPx = (cardsPerColumn - 1) * CARD_GAP_PX;
  return `clamp(${CARD_MIN_HEIGHT_PX}px, calc((100dvh - ${HEADER_RESERVE_PX}px - ${gapTotalPx}px) / ${cardsPerColumn}), ${CARD_MAX_HEIGHT_PX}px)`;
}

// 列分割が必要かどうかを判定する際の「画面の高さ」の目安値（実際のビューポート高さは
// サーバー側ではわからないため、一般的なノートPCの高さを仮定する）。CSS側の計算式
// （compactHeightStyle）と同じ定数（HEADER_RESERVE_PX・CARD_GAP_PX）を使って逆算することで、
// 「下限サイズでギリギリ収まる列あたり枚数」を実際のCSS計算と矛盾しないようにする。
const ASSUMED_VIEWPORT_HEIGHT_PX = 900;

/**
 * 1年のカード枚数が、下限サイズでも1列に収まらない場合だけ、必要最小限の列数に分割する
 * （折り返しではなく、その年専用に列を増やすだけ）。分割後の「1列あたりの最大枚数」を
 * 全年で共有し、それをカードサイズの計算に使う（列を分けた年もそうでない年も同じ大きさになる）。
 */
function planCompactColumns(
  yearGroups: { year: number; cards: BannedCardWithCard[] }[],
): { columnsByYear: Map<number, BannedCardWithCard[][]>; maxCardsPerColumn: number } {
  // capacity*(MIN+GAP) = ASSUMED - RESERVE + GAP を解いたもの（compactHeightStyleの式の逆算）
  const capacityAtMinHeight = Math.max(
    1,
    Math.floor(
      (ASSUMED_VIEWPORT_HEIGHT_PX - HEADER_RESERVE_PX + CARD_GAP_PX) / (CARD_MIN_HEIGHT_PX + CARD_GAP_PX),
    ),
  );
  const columnsByYear = new Map<number, BannedCardWithCard[][]>();
  let maxCardsPerColumn = 1;

  for (const { year, cards } of yearGroups) {
    const numColumns = Math.max(1, Math.ceil(cards.length / capacityAtMinHeight));
    const perColumn = Math.ceil(cards.length / numColumns) || 1;
    const columns: BannedCardWithCard[][] = [];
    for (let i = 0; i < cards.length; i += perColumn) {
      columns.push(cards.slice(i, i + perColumn));
    }
    if (columns.length === 0) columns.push([]);
    columnsByYear.set(year, columns);
    maxCardsPerColumn = Math.max(maxCardsPerColumn, perColumn);
  }

  return { columnsByYear, maxCardsPerColumn };
}

export default async function BannedCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; format?: string; sort?: string; fillGaps?: string; view?: string; colors?: string }>;
}) {
  const sp = await searchParams;
  const tab: TabKey = isTab(sp.tab) ? sp.tab : "current";
  const format: Format = isFormat(sp.format) ? sp.format : "Standard";
  const sortDir: "asc" | "desc" = sp.sort === "asc" ? "asc" : "desc";
  const fillGaps = sp.fillGaps === "1";
  const view: "list" | "compact" = sp.view === "compact" ? "compact" : "list";
  const colors = parseColors(sp.colors);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">禁止カード</h1>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={buildHref(tab, format, sortDir, fillGaps, view, { tab: t.key })}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              t.key === tab
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "current" && <CurrentBannedTab format={format} colors={colors} />}
      {tab === "reserved" && <ReservedListTab colors={colors} />}
      {tab === "history" && (
        <HistoryTab tab={tab} format={format} sortDir={sortDir} fillGaps={fillGaps} view={view} />
      )}
    </div>
  );
}

async function CurrentBannedTab({ format, colors }: { format: Format; colors: ColorFilter[] }) {
  const allCards = await getCurrentlyBannedCards(format);
  const cards = allCards.filter((c) => matchesColorFilter(c.colors, colors));
  const buildColorHref = (next: ColorFilter[]) => {
    const params = new URLSearchParams();
    if (format !== "Standard") params.set("format", format);
    if (next.length > 0) params.set("colors", next.join(","));
    const qs = params.toString();
    return qs ? `/banned-cards?${qs}` : "/banned-cards";
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {FORMATS.map((f) => (
          <Link
            key={f}
            href={buildHref("current", f, "desc", false, "list", {})}
            className={`rounded-md border px-3 py-1 text-sm ${
              f === format
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {formatLabelJa(f)}
          </Link>
        ))}
      </div>
      <ColorFilterRow selected={colors} buildColorHref={buildColorHref} />
      {cards.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {colors.length > 0
            ? "選択した色に一致するカードはありません。"
            : `${formatLabelJa(format)}に現在禁止/制限中のカードはありません。`}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
          {cards.map((card) => (
            <Link
              key={card.oracleId}
              href={`/cards/${card.oracleId}`}
              className="group relative flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-neutral-50"
            >
              {card.imageUrl ? (
                <Image
                  src={toSmallImageUrl(card.imageUrl)}
                  alt={card.nameJa ?? card.name}
                  width={146}
                  height={204}
                  className="w-full rounded-md"
                />
              ) : (
                <div className="flex aspect-[223/311] w-full items-center justify-center rounded-md bg-neutral-100 text-center text-xs text-neutral-400">
                  {card.nameJa ?? card.name}
                </div>
              )}
              {card.status === "restricted" && (
                <span className="pointer-events-none absolute top-0.5 right-0.5 rounded-full bg-amber-500 px-1 text-[9px] leading-tight font-bold text-white shadow">
                  制限
                </span>
              )}
              <p className="truncate text-center text-xs font-medium">{card.nameJa ?? card.name}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

async function ReservedListTab({ colors }: { colors: ColorFilter[] }) {
  const allCards = await getReservedListCards();
  const cards = allCards.filter((c) => matchesColorFilter(c.colors, colors));
  const buildColorHref = (next: ColorFilter[]) => {
    const params = new URLSearchParams();
    params.set("tab", "reserved");
    if (next.length > 0) params.set("colors", next.join(","));
    return `/banned-cards?${params.toString()}`;
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-500">
        {allCards.length.toLocaleString()}枚（価格が高い順）。Wizards of the Coastが将来的にも再録しないと
        約束しているカード一覧。
      </p>
      <ColorFilterRow selected={colors} buildColorHref={buildColorHref} />
      {cards.length === 0 && (
        <p className="text-sm text-neutral-500">選択した色に一致するカードはありません。</p>
      )}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
        {cards.map((card) => (
          <Link
            key={card.oracleId}
            href={`/cards/${card.oracleId}`}
            className="flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-neutral-50"
          >
            {card.imageUrl ? (
              <Image
                src={toSmallImageUrl(card.imageUrl)}
                alt={card.name}
                width={146}
                height={204}
                className="w-full rounded-md"
              />
            ) : (
              <div className="flex aspect-[223/311] w-full items-center justify-center rounded-md bg-neutral-100 text-center text-xs text-neutral-400">
                {card.nameJa ?? card.name}
              </div>
            )}
            <p className="truncate text-center text-xs font-medium">{card.nameJa ?? card.name}</p>
            {card.priceJpy != null && (
              <p className="text-xs text-neutral-500">¥{card.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

async function HistoryTab({
  tab,
  format,
  sortDir,
  fillGaps,
  view,
}: {
  tab: TabKey;
  format: Format;
  sortDir: "asc" | "desc";
  fillGaps: boolean;
  view: "list" | "compact";
}) {
  const yearGroups = await getBannedCardsByYear(format, { sortDir, fillGaps });
  const hasRestricted = yearGroups.some((g) => g.cards.some((c) => c.status === "restricted"));

  const { columnsByYear, maxCardsPerColumn } = planCompactColumns(yearGroups);
  const compactHeight = compactHeightStyle(maxCardsPerColumn);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FORMATS.map((f) => (
            <Link
              key={f}
              href={buildHref(tab, format, sortDir, fillGaps, view, { format: f })}
              className={`rounded-md border px-3 py-1 text-sm ${
                f === format
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {formatLabelJa(f)}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link
            href={buildHref(tab, format, sortDir, fillGaps, view, { view: view === "compact" ? "list" : "compact" })}
            className={`rounded-md border px-3 py-1 text-sm ${
              view === "compact"
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {view === "compact" ? "リスト表示" : "1画面で見る"}
          </Link>
          <Link
            href={buildHref(tab, format, sortDir, fillGaps, view, { sortDir: sortDir === "desc" ? "asc" : "desc" })}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-500 hover:border-neutral-500"
          >
            {sortDir === "desc" ? "古い順に並び替え" : "新しい順に並び替え"}
          </Link>
          <Link
            href={buildHref(tab, format, sortDir, fillGaps, view, { fillGaps: !fillGaps })}
            className={`rounded-md border px-3 py-1 text-sm ${
              fillGaps
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            禁止が無かった年も表示
          </Link>
        </div>
      </div>

      {hasRestricted && (
        <div className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className="inline-block h-3 w-3 rounded-full bg-amber-500" />
          制限（1枚まで）。それ以外は禁止（0枚）。
        </div>
      )}

      {yearGroups.length === 0 ? (
        <p className="text-sm text-neutral-500">{format}の禁止カードデータは準備中です。</p>
      ) : view === "compact" ? (
        <div
          className="flex w-screen items-end justify-center gap-3 overflow-x-auto px-4 pb-2"
          style={{ marginLeft: "calc(50% - 50vw)" }}
        >
          {yearGroups.map(({ year }) => (
            <div key={year} className="flex shrink-0 flex-col items-center gap-1.5">
              <div className="flex items-end gap-0.5">
                {(columnsByYear.get(year) ?? []).map((col, ci) => (
                  <div key={ci} className="flex flex-col gap-1">
                    {col.map((card) => (
                      <CardThumb key={card.oracleId} card={card} heightStyle={compactHeight} />
                    ))}
                  </div>
                ))}
              </div>
              <div className="w-16 border-t border-neutral-300 pt-1 text-center text-xs font-medium text-neutral-600">
                {year}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-100">
          {yearGroups.map(({ year, cards }) => (
            <div key={year} className="flex items-center gap-3 py-2.5">
              <div className="w-14 shrink-0 text-sm font-semibold text-neutral-700">{year}</div>
              <div className="flex min-h-[90px] flex-1 flex-wrap gap-1.5">
                {cards.map((card) => (
                  <CardThumb key={card.oracleId} card={card} heightStyle={LIST_CARD_HEIGHT_PX} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
