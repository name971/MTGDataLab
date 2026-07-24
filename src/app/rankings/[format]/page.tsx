import { notFound } from "next/navigation";
import Link from "next/link";
import { FORMATS, formatSlug, type Format } from "@/lib/formats";
import { getSampleRanking } from "@/lib/sampleRankingData";
import { getFormatSettings } from "@/lib/formatSettings";
import { applyDbPrices, applyDbUsageRates } from "@/lib/applyDbPrices";
import { getCardRankingFromDb } from "@/lib/dbCardRanking";
import RankingTable from "@/components/RankingTable";

function resolveFormat(slug: string): Format | null {
  return FORMATS.find((f) => formatSlug(f) === slug) ?? null;
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
}: {
  params: Promise<{ format: string }>;
}) {
  const { format: slug } = await params;
  const format = resolveFormat(slug);
  if (!format) notFound();

  const { periodDays } = await getFormatSettings(format);
  const dbRows = await getCardRankingFromDb(format);
  const rows =
    dbRows.length > 0
      ? dbRows
      : await applyDbUsageRates(await applyDbPrices(getSampleRanking(format)), format);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">カードランキング</h1>

      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <Link
            key={f}
            href={`/rankings/${formatSlug(f)}`}
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

      <p className="text-sm text-neutral-500">集計期間: 直近{periodDays}日</p>
      <RankingTable rows={rows} showArenaPrice={format === "Standard"} />
    </div>
  );
}
