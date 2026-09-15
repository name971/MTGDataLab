import Link from "next/link";
import { getWeeklyMovers, type MoverCategory } from "@/lib/dbWeeklyMovers";
import WeeklyMoversList from "@/components/WeeklyMoversList";
import { isLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

// 集計バッチ（compute-weekly-movers.mjs）は1日1回しか回らないため、長めにキャッシュする
export const revalidate = 21600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  return { title: getDictionary(locale).trending.metaTitle };
}

function resolveCategory(raw: string | undefined): MoverCategory {
  return raw === "usage" ? "usage" : "price";
}

// ユーザー要望（2026-08-27）: 標準で円（金額差）ランキングを選ぶ
function resolveMetric(raw: string | undefined): "pct" | "jpy" {
  return raw === "pct" ? "pct" : "jpy";
}

function resolveUsageDirection(raw: string | undefined): "up" | "down" {
  return raw === "down" ? "down" : "up";
}

export default async function TrendingRankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ category?: string; metric?: string; dir?: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).trending;
  const CATEGORIES: { key: MoverCategory; label: string }[] = [
    { key: "price", label: t.priceCategory },
    { key: "usage", label: t.usageCategory },
  ];
  const sp = await searchParams;
  const category = resolveCategory(sp.category);
  const metric = resolveMetric(sp.metric);
  const usageDirection = resolveUsageDirection(sp.dir);

  // フィルター適用後にページが歯抜けにならないよう、Top100を全件まとめて取得し、
  // ページングはWeeklyMoversList.tsx（クライアント側、フィルター後の配列に対して）で行う
  // （MlRankingList.tsxと同じ方式、2026-08-27）。
  const { rows } = await getWeeklyMovers(category, metric, usageDirection);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{t.heading}</h1>
        <p className="text-sm text-neutral-500">{t.subheading}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <Link
              key={c.key}
              href={`/${locale}/trending?category=${c.key}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                c.key === category
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
              }`}
            >
              {c.label}
            </Link>
          ))}
        </div>
        {category === "price" && (
          <div className="flex gap-1">
            <Link
              href={`/${locale}/trending?category=${category}&metric=pct`}
              aria-label={t.pctRankingLabel}
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                metric === "pct"
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              %
            </Link>
            <Link
              href={`/${locale}/trending?category=${category}&metric=jpy`}
              aria-label={t.jpyRankingLabel}
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                metric === "jpy"
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {t.jpyUnit}
            </Link>
          </div>
        )}
        {category === "usage" && (
          <div className="flex gap-1">
            <Link
              href={`/${locale}/trending?category=usage&dir=up`}
              aria-label={t.upRankingLabel}
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                usageDirection === "up"
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {t.upLabel}
            </Link>
            <Link
              href={`/${locale}/trending?category=usage&dir=down`}
              aria-label={t.downRankingLabel}
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                usageDirection === "down"
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {t.downLabel}
            </Link>
          </div>
        )}
      </div>

      {rows.length > 0 ? (
        <WeeklyMoversList rows={rows} category={category} priceMetric={metric} />
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">
          {t.noData}
        </p>
      )}
    </div>
  );
}
