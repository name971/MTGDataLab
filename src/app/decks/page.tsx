import Link from "next/link";
import { FORMATS, formatSlug, type Format } from "@/lib/formats";
import { getSampleArchetypes } from "@/lib/sampleDeckData";
import { getFormatSettings } from "@/lib/formatSettings";
import { getRecentDecksFromDb } from "@/lib/dbDeckDetail";
import { getArchetypesFromDb } from "@/lib/dbArchetypeStats";
import DeckRankingTable from "@/components/DeckRankingTable";

function resolveFormat(slug: string | undefined): Format {
  return FORMATS.find((f) => formatSlug(f) === slug) ?? "Standard";
}

export const metadata = { title: "デッキランキング - MTG DataLab" };

export default async function DeckRankingPage({
  searchParams,
}: {
  searchParams: Promise<{ format?: string }>;
}) {
  const { format: formatParam } = await searchParams;
  const format = resolveFormat(formatParam);
  const dbRows = await getArchetypesFromDb(format);
  const rows = dbRows.length > 0 ? dbRows : getSampleArchetypes(format);
  const { caveatNote } = await getFormatSettings(format);
  const recentDecks = await getRecentDecksFromDb(format);

  const top10 = rows.slice(0, 10);
  const top10AvgPriceJpy =
    top10.length > 0
      ? Math.round(top10.reduce((sum, r) => sum + r.medianPriceJpy, 0) / top10.length)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">デッキ単位のランキング（アーキタイプランキング）</h1>
        </div>
        {top10AvgPriceJpy !== null && (
          <p className="whitespace-nowrap text-sm text-neutral-600">
            上位{top10.length}デッキ平均:{" "}
            <span className="text-lg font-semibold text-neutral-900">
              ¥{top10AvgPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <Link
            key={f}
            href={`/decks?format=${formatSlug(f)}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              f === format
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
            }`}
          >
            {f}
          </Link>
        ))}
      </div>

      {caveatNote && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{caveatNote}</div>
      )}

      {rows.length > 0 ? (
        <DeckRankingTable rows={rows} />
      ) : (
        <p className="text-sm text-neutral-500">このフォーマットのデータはまだありません。</p>
      )}

      {recentDecks.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">
            実際のトーナメント戦績デッキ
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {recentDecks.map((deck) => (
              <li key={deck.deckId}>
                <Link href={`/decks/${deck.deckId}`} className="hover:underline">
                  {deck.playerName}
                </Link>
                <span className="text-neutral-500">
                  {" "}
                  ({deck.standing}) ・ {deck.eventName}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
