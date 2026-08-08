import { notFound } from "next/navigation";
import Link from "next/link";
import { FORMATS, formatSlug, type Format } from "@/lib/formats";
import { getFormatSettings } from "@/lib/formatSettings";
import { getCardRankingFromDb } from "@/lib/dbCardRanking";
import RankingTable from "@/components/RankingTable";

// 集計バッチは1日1回しか回らないため、長めにキャッシュしてegressを抑える
export const revalidate = 21600;

function resolveFormat(slug: string): Format | null {
  return FORMATS.find((f) => formatSlug(f) === slug) ?? null;
}

const PERIOD_OPTIONS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

function resolvePeriod(raw: string | undefined): PeriodDays {
  const n = Number(raw);
  return (PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as PeriodDays) : 30;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ format: string }>;
}) {
  const { format: slug } = await params;
  const format = resolveFormat(slug);
  return { title: format ? `${format} カードランキング - MTG DataLab` : "MTG DataLab" };
}

export default async function FormatRankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ format: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { format: slug } = await params;
  const format = resolveFormat(slug);
  if (!format) notFound();

  const { period } = await searchParams;
  const periodDays = resolvePeriod(period);

  const { caveatNote } = await getFormatSettings(format);
  const rows = await getCardRankingFromDb(format, periodDays);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">カードランキング</h1>

      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <Link
            key={f}
            href={`/rankings/${formatSlug(f)}${periodDays !== 30 ? `?period=${periodDays}` : ""}`}
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
            href={`/rankings/${formatSlug(format)}?period=${p}`}
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
      {caveatNote && <p className="text-xs text-neutral-400">{caveatNote}</p>}

      {rows.length > 0 ? (
        <RankingTable rows={rows} />
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">
          この期間・フォーマットではまだ実データがありません。期間タブを変えてみてください。
        </p>
      )}
    </div>
  );
}
