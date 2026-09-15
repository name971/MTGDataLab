import Image from "next/image";
import Link from "next/link";
import { searchCardsInDb } from "@/lib/searchCards";
import { searchSampleCards } from "@/lib/sampleSearchIndex";
import { slugForCardName } from "@/lib/sampleCards";
import { meetsMinQueryLength } from "@/lib/searchQuery";
import { isLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  return { title: getDictionary(locale).searchPage.metaTitle };
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).searchPage;
  const { q } = await searchParams;
  const query = q ?? "";

  const dbResults = await searchCardsInDb(query);
  // DB検索がヒットしない場合（未インポートのクエリ等）はサンプルデータにフォールバックする
  const results =
    dbResults.length > 0
      ? dbResults.map((r) => ({
          oracleId: slugForCardName(r.nameEn) ?? r.oracleId,
          nameJa: r.nameJa ?? r.nameEn,
          nameEn: r.nameEn,
          artCropUrl: r.artCropUrl,
        }))
      : searchSampleCards(query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">{t.resultsFor(query)}</h1>
        <Link href={`/${locale}/search/advanced`} className="text-sm text-neutral-500 hover:underline">
          {t.advancedSearch}
        </Link>
      </div>

      {results.length > 0 ? (
        <div className="flex flex-col gap-2">
          {results.map((card) => (
            <Link
              key={card.oracleId}
              href={`/${locale}/cards/${card.oracleId}`}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 hover:border-neutral-400"
            >
              {card.artCropUrl && (
                <Image
                  src={card.artCropUrl}
                  alt={card.nameEn}
                  width={40}
                  height={40}
                  className="h-10 w-10 shrink-0 rounded-md object-cover"
                />
              )}
              <div>
                <p className="text-sm font-medium">{locale === "ja" ? card.nameJa : card.nameEn}</p>
                {locale === "ja" && <p className="text-xs text-neutral-500">{card.nameEn}</p>}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          {!meetsMinQueryLength(query.trim()) ? t.minLength : t.noResults}
        </p>
      )}
    </div>
  );
}
