import Image from "next/image";
import Link from "next/link";
import { FORMATS, type Format } from "@/lib/formats";
import { getBannedCardsByYear, type BannedCardWithCard } from "@/lib/dbBannedCards";

export const metadata = { title: "歴代禁止カード - MTG DataLab" };

// 禁止カード自体の追加頻度は低い（bannedCards.tsの手動更新のみ）ため、長めのキャッシュで十分
export const revalidate = 21600;

function isFormat(v: string | undefined): v is Format {
  return (FORMATS as readonly string[]).includes(v ?? "");
}

function buildHref(
  format: Format,
  sortDir: "asc" | "desc",
  fillGaps: boolean,
  view: "list" | "compact",
  overrides: Partial<{ format: Format; sortDir: "asc" | "desc"; fillGaps: boolean; view: "list" | "compact" }>,
): string {
  const next = { format, sortDir, fillGaps, view, ...overrides };
  const params = new URLSearchParams();
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

// カード画像の縦横比（通常のカード比率、既存のリスト表示と同じ64:90）
const CARD_ASPECT = 64 / 90;

function CardThumb({ card, height }: { card: BannedCardWithCard; height: number }) {
  const borderClass = card.status === "restricted" ? "border-amber-500" : "border-neutral-200";
  const width = Math.round(height * CARD_ASPECT);
  return (
    <Link
      key={card.oracleId}
      href={`/cards/${card.oracleId}`}
      className="group relative block shrink-0 hover:z-20"
      title={cardTitle(card)}
    >
      {card.imageUrl ? (
        <Image
          src={card.imageUrl}
          alt={card.nameJa ?? card.name}
          width={width}
          height={height}
          className={`rounded-sm border group-hover:border-neutral-500 ${borderClass}`}
        />
      ) : (
        <div
          className={`flex items-center justify-center overflow-hidden rounded-sm border bg-neutral-100 text-center text-[8px] text-neutral-400 ${borderClass}`}
          style={{ width, height }}
        >
          {card.nameJa ?? card.name}
        </div>
      )}
      {card.status === "restricted" && (
        <span className="pointer-events-none absolute -top-1 -right-1 rounded-full bg-amber-500 px-1 text-[8px] font-bold leading-tight text-white shadow">
          制限
        </span>
      )}
    </Link>
  );
}

// コンパクト表示（1画面で見る）で使える縦幅の見積もり。実際のビューポート高さはサーバー側の
// レンダリング時点ではわからないため、ヘッダー・タイトル・操作ボタン・軸ラベル等を差し引いた
// 概算値を固定で使う（一般的なノートPC〜デスクトップのウィンドウ高さを想定）。
const COMPACT_AVAILABLE_HEIGHT_PX = 600;
// これより小さいとカードの絵柄・違いが判別しづらくなる下限の高さ
const CARD_MIN_HEIGHT_PX = 26;
const CARD_MAX_HEIGHT_PX = 90; // リスト表示と同じ通常サイズが上限（それ以上に拡大はしない）
const COLUMN_GAP_PX = 3;

/**
 * 各年のカードを列に分ける。方針: 折り返し（幅方向に自然に増える）や山札のような
 * 重ね合わせではなく、全体で1つの「1枚あたりの高さ」を共有し、最も枚数が多い年が
 * その高さでちょうど画面に収まるようにする（＝縦幅を使い切る、呼び出し側で計算）。
 * それでも下限サイズで1列に収まらない年だけ、必要最小限の列数に分割する。
 */
function splitIntoColumns<T>(items: T[], cardsPerColumn: number): T[][] {
  const numColumns = Math.max(1, Math.ceil(items.length / cardsPerColumn));
  const perColumn = Math.ceil(items.length / numColumns);
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += perColumn) {
    columns.push(items.slice(i, i + perColumn));
  }
  return columns;
}

export default async function BannedCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ format?: string; sort?: string; fillGaps?: string; view?: string }>;
}) {
  const sp = await searchParams;
  const format: Format = isFormat(sp.format) ? sp.format : "Standard";
  const sortDir: "asc" | "desc" = sp.sort === "asc" ? "asc" : "desc";
  const fillGaps = sp.fillGaps === "1";
  const view: "list" | "compact" = sp.view === "compact" ? "compact" : "list";
  const yearGroups = await getBannedCardsByYear(format, { sortDir, fillGaps });
  const hasRestricted = yearGroups.some((g) => g.cards.some((c) => c.status === "restricted"));

  const maxCount = Math.max(1, ...yearGroups.map((g) => g.cards.length));
  const capacityAtMinHeight = Math.max(
    1,
    Math.floor(COMPACT_AVAILABLE_HEIGHT_PX / (CARD_MIN_HEIGHT_PX + COLUMN_GAP_PX)),
  );
  const compactCardHeight =
    maxCount <= capacityAtMinHeight
      ? Math.max(
          CARD_MIN_HEIGHT_PX,
          Math.min(CARD_MAX_HEIGHT_PX, Math.floor(COMPACT_AVAILABLE_HEIGHT_PX / maxCount) - COLUMN_GAP_PX),
        )
      : CARD_MIN_HEIGHT_PX;
  const compactCardsPerColumn = Math.max(
    1,
    Math.floor(COMPACT_AVAILABLE_HEIGHT_PX / (compactCardHeight + COLUMN_GAP_PX)),
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">歴代禁止カード</h1>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FORMATS.map((f) => (
            <Link
              key={f}
              href={buildHref(format, sortDir, fillGaps, view, { format: f })}
              className={`rounded-md border px-3 py-1 text-sm ${
                f === format
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {f}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link
            href={buildHref(format, sortDir, fillGaps, view, { view: view === "compact" ? "list" : "compact" })}
            className={`rounded-md border px-3 py-1 text-sm ${
              view === "compact"
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {view === "compact" ? "リスト表示" : "1画面で見る"}
          </Link>
          <Link
            href={buildHref(format, sortDir, fillGaps, view, { sortDir: sortDir === "desc" ? "asc" : "desc" })}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-500 hover:border-neutral-500"
          >
            {sortDir === "desc" ? "古い順に並び替え" : "新しい順に並び替え"}
          </Link>
          <Link
            href={buildHref(format, sortDir, fillGaps, view, { fillGaps: !fillGaps })}
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
          {yearGroups.map(({ year, cards }) => {
            const columns = splitIntoColumns(cards, compactCardsPerColumn);
            return (
              <div key={year} className="flex shrink-0 flex-col items-center gap-1.5">
                <div className="flex items-end gap-0.5">
                  {columns.map((col, ci) => (
                    <div key={ci} className="flex flex-col" style={{ gap: COLUMN_GAP_PX }}>
                      {col.map((card) => (
                        <CardThumb key={card.oracleId} card={card} height={compactCardHeight} />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="w-16 border-t border-neutral-300 pt-1 text-center text-xs font-medium text-neutral-600">
                  {year}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-100">
          {yearGroups.map(({ year, cards }) => (
            <div key={year} className="flex items-center gap-3 py-2.5">
              <div className="w-14 shrink-0 text-sm font-semibold text-neutral-700">{year}</div>
              <div className="flex min-h-[90px] flex-1 flex-wrap gap-1.5">
                {cards.map((card) => (
                  <CardThumb key={card.oracleId} card={card} height={90} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
