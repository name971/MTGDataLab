import Link from "next/link";
import { getWeeklyMovers, WEEKLY_MOVERS_PAGE_SIZE, WEEKLY_MOVERS_TOP_N, type MoverCategory } from "@/lib/dbWeeklyMovers";
import WeeklyMoversList from "@/components/WeeklyMoversList";

// 集計バッチ（compute-weekly-movers.mjs）は1日1回しか回らないため、長めにキャッシュする
export const revalidate = 21600;

export const metadata = { title: "週間ランキング - MTG DataLab" };

const CATEGORIES: { key: MoverCategory; label: string }[] = [
  { key: "price", label: "値上がりランキング" },
  { key: "usage", label: "採用率上昇ランキング" },
];

const TOTAL_PAGES = WEEKLY_MOVERS_TOP_N / WEEKLY_MOVERS_PAGE_SIZE;

function resolveCategory(raw: string | undefined): MoverCategory {
  return raw === "usage" ? "usage" : "price";
}

function resolvePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_PAGES ? n : 1;
}

export default async function TrendingRankingPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const category = resolveCategory(sp.category);
  const page = resolvePage(sp.page);

  const { rows, totalCount } = await getWeeklyMovers(category, page);
  const totalPages = Math.max(1, Math.min(TOTAL_PAGES, Math.ceil(totalCount / WEEKLY_MOVERS_PAGE_SIZE)));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">週間ランキング</h1>
        <p className="text-sm text-neutral-500">直近7日間の変化でTop100を毎日更新</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <Link
            key={c.key}
            href={`/rankings/trending?category=${c.key}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              c.key === category
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
            }`}
          >
            {c.label}
          </Link>
        ))}
      </div>

      {rows.length > 0 ? (
        <WeeklyMoversList rows={rows} category={category} />
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">
          まだ集計データがありません。しばらくしてから見に来てください。
        </p>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/rankings/trending?category=${category}&page=${p}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                p === page
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
