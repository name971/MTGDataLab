import Image from "next/image";
import Link from "next/link";
import { FORMATS, type Format } from "@/lib/formats";
import { getBannedCardsByYear } from "@/lib/dbBannedCards";

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
  overrides: Partial<{ format: Format; sortDir: "asc" | "desc"; fillGaps: boolean }>,
): string {
  const next = { format, sortDir, fillGaps, ...overrides };
  const params = new URLSearchParams();
  if (next.format !== "Standard") params.set("format", next.format);
  if (next.sortDir !== "desc") params.set("sort", next.sortDir);
  if (next.fillGaps) params.set("fillGaps", "1");
  const qs = params.toString();
  return qs ? `/banned-cards?${qs}` : "/banned-cards";
}

export default async function BannedCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ format?: string; sort?: string; fillGaps?: string }>;
}) {
  const sp = await searchParams;
  const format: Format = isFormat(sp.format) ? sp.format : "Standard";
  const sortDir: "asc" | "desc" = sp.sort === "asc" ? "asc" : "desc";
  const fillGaps = sp.fillGaps === "1";
  const yearGroups = await getBannedCardsByYear(format, { sortDir, fillGaps });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">歴代禁止カード</h1>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FORMATS.map((f) => (
            <Link
              key={f}
              href={buildHref(format, sortDir, fillGaps, { format: f })}
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
            href={buildHref(format, sortDir, fillGaps, { sortDir: sortDir === "desc" ? "asc" : "desc" })}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm text-neutral-500 hover:border-neutral-500"
          >
            {sortDir === "desc" ? "古い順に並び替え" : "新しい順に並び替え"}
          </Link>
          <Link
            href={buildHref(format, sortDir, fillGaps, { fillGaps: !fillGaps })}
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

      {yearGroups.length === 0 ? (
        <p className="text-sm text-neutral-500">{format}の禁止カードデータは準備中です。</p>
      ) : (
        <div className="flex flex-col divide-y divide-neutral-100">
          {yearGroups.map(({ year, cards }) => (
            <div key={year} className="flex items-start gap-3 py-2.5">
              <div className="w-14 shrink-0 pt-1 text-sm font-semibold text-neutral-700">{year}</div>
              <div className="flex min-h-[90px] flex-1 flex-wrap gap-1.5">
                {cards.map((card) => (
                  <Link
                    key={card.oracleId}
                    href={`/cards/${card.oracleId}`}
                    className="group relative shrink-0"
                    title={`${card.nameJa ?? card.name}${card.month ? ` (${card.year}年${card.month}月禁止)` : ""}`}
                  >
                    {card.imageUrl ? (
                      <Image
                        src={card.imageUrl}
                        alt={card.nameJa ?? card.name}
                        width={64}
                        height={90}
                        className="rounded-md border border-neutral-200 group-hover:border-neutral-500"
                      />
                    ) : (
                      <div className="flex h-[90px] w-16 items-center justify-center rounded-md border border-neutral-200 bg-neutral-100 text-center text-[10px] text-neutral-400">
                        {card.nameJa ?? card.name}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
