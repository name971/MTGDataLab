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

function CardThumb({ card }: { card: BannedCardWithCard }) {
  const borderClass = card.status === "restricted" ? "border-amber-500" : "border-neutral-200";
  return (
    <Link
      key={card.oracleId}
      href={`/cards/${card.oracleId}`}
      className="group relative block shrink-0"
      title={cardTitle(card)}
    >
      {card.imageUrl ? (
        <Image
          src={card.imageUrl}
          alt={card.nameJa ?? card.name}
          width={64}
          height={90}
          className={`rounded-md border-2 group-hover:border-neutral-500 ${borderClass}`}
        />
      ) : (
        <div
          className={`flex h-[90px] w-16 items-center justify-center rounded-md border-2 bg-neutral-100 text-center text-[10px] text-neutral-400 ${borderClass}`}
        >
          {card.nameJa ?? card.name}
        </div>
      )}
      {card.status === "restricted" && (
        <span className="pointer-events-none absolute -top-1 -right-1 rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-tight text-white shadow">
          制限
        </span>
      )}
    </Link>
  );
}

// コンパクト表示で1年のカード数が多いと縦に伸びすぎて全体が見づらくなるため、
// 一定数を超えたら折り返して複数列にする（flex-wrapで自然に列が増える）
const COMPACT_COLUMN_MAX_HEIGHT_PX = 6 * (90 + 6); // カード6枚分の高さ

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
          className="flex w-screen items-end justify-center gap-2 overflow-x-auto px-4 pb-2"
          style={{ marginLeft: "calc(50% - 50vw)" }}
        >
          {yearGroups.map(({ year, cards }) => (
            <div key={year} className="flex shrink-0 flex-col items-center gap-1.5">
              <div
                className="flex flex-col flex-wrap gap-1.5"
                style={{ maxHeight: COMPACT_COLUMN_MAX_HEIGHT_PX }}
              >
                {cards.map((card) => (
                  <CardThumb key={card.oracleId} card={card} />
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
                  <CardThumb key={card.oracleId} card={card} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
