import Link from "next/link";
import { FORMATS, formatSlug, type Format } from "@/lib/formats";
import { getSampleArchetypes } from "@/lib/sampleDeckData";
import { getFormatSettings } from "@/lib/formatSettings";
import { getRecentDecksFromDb } from "@/lib/dbDeckDetail";
import { getArchetypesFromDb } from "@/lib/dbArchetypeStats";
import DeckRankingTable from "@/components/DeckRankingTable";

// 集計バッチは1日1回しか回らないため、長めにキャッシュしてegressを抑える
export const revalidate = 21600;

function resolveFormat(slug: string | undefined): Format {
  return FORMATS.find((f) => formatSlug(f) === slug) ?? "Standard";
}

const PERIOD_OPTIONS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

function resolvePeriod(raw: string | undefined): PeriodDays {
  const n = Number(raw);
  return (PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as PeriodDays) : 30;
}

export const metadata = { title: "デッキランキング - MTG DataLab" };

export default async function DeckRankingPage({
  searchParams,
}: {
  searchParams: Promise<{ format?: string; period?: string }>;
}) {
  const { format: formatParam, period } = await searchParams;
  const format = resolveFormat(formatParam);
  const periodDays = resolvePeriod(period);
  // 互いに依存しないので並列実行する
  const [dbRows, { caveatNote }, recentDecks] = await Promise.all([
    getArchetypesFromDb(format, periodDays),
    getFormatSettings(format),
    getRecentDecksFromDb(format),
  ]);
  // サンプルデータへのフォールバックは「このフォーマットはDBにまだ実データが無い」場合のみに限る。
  // 期間だけ絞り込んだ結果が0件（分類バッチがまだ直近分を処理していない等）の場合にサンプルへ
  // 差し替えると、無関係なハードコード値が実データのように表示されてしまう
  // （画像URLも持たないため「画像なし」になり、一見バグに見える）。その場合は空状態を出す。
  let rows = dbRows;
  if (dbRows.length === 0) {
    const hasAnyDbData = periodDays === 30 ? false : (await getArchetypesFromDb(format, 30)).length > 0;
    rows = hasAnyDbData ? [] : getSampleArchetypes(format);
  }

  const top10 = rows.slice(0, 10);
  const top10AvgPriceJpy =
    top10.length > 0
      ? Math.round(top10.reduce((sum, r) => sum + r.medianPriceJpy, 0) / top10.length)
      : null;
  // arenaMedianPriceJpyはStandardのみ付く（dbArchetypeStats.ts参照）。値がある行だけで平均を取る
  const top10ArenaRows = top10.filter((r) => r.arenaMedianPriceJpy !== undefined);
  const top10ArenaAvgPriceJpy =
    top10ArenaRows.length > 0
      ? Math.round(top10ArenaRows.reduce((sum, r) => sum + r.arenaMedianPriceJpy!, 0) / top10ArenaRows.length)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold sm:text-xl">デッキ単位のランキング（アーキタイプランキング）</h1>
        </div>
        {top10AvgPriceJpy !== null && (
          <div className="flex flex-col items-start gap-0.5 sm:items-end">
            <p className="whitespace-nowrap text-sm text-neutral-600">
              上位{top10.length}デッキ平均:{" "}
              <span className="text-lg font-semibold text-neutral-900">
                ¥{top10AvgPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
              </span>
            </p>
            {top10ArenaAvgPriceJpy !== null && (
              <p
                title="ワイルドカード換算：レア¥1,500/4枚、神話レア¥3,000/4枚、コモン・アンコモン¥0"
                className="cursor-help whitespace-nowrap text-xs text-neutral-500"
              >
                MTG Arena換算平均:{" "}
                <span className="font-medium text-neutral-700">
                  ¥{top10ArenaAvgPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <Link
            key={f}
            href={`/decks?format=${formatSlug(f)}${periodDays !== 30 ? `&period=${periodDays}` : ""}`}
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

      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-500">集計期間:</span>
        {PERIOD_OPTIONS.map((p) => (
          <Link
            key={p}
            href={`/decks?format=${formatSlug(format)}&period=${p}`}
            className={`rounded-md border px-2 py-1 text-xs ${
              p === periodDays
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            直近{p}日
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
