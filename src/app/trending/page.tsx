import Link from "next/link";
import { getWeeklyMovers, type MoverCategory } from "@/lib/dbWeeklyMovers";
import WeeklyMoversList from "@/components/WeeklyMoversList";

// 集計バッチ（compute-weekly-movers.mjs）は1日1回しか回らないため、長めにキャッシュする
export const revalidate = 21600;

export const metadata = { title: "週間ランキング - MTG DataLab" };

const CATEGORIES: { key: MoverCategory; label: string }[] = [
  { key: "price", label: "値上がりランキング" },
  { key: "usage", label: "採用率ランキング" },
];

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
  searchParams,
}: {
  searchParams: Promise<{ category?: string; metric?: string; dir?: string }>;
}) {
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
        <h1 className="text-xl font-semibold">週間ランキング</h1>
        <p className="text-sm text-neutral-500">直近7日間の変化でTop300を毎日更新</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <Link
              key={c.key}
              href={`/trending?category=${c.key}`}
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
        {category === "price" && (
          <div className="flex gap-1">
            <Link
              href={`/trending?category=${category}&metric=pct`}
              aria-label="%ランキング"
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                metric === "pct"
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              %
            </Link>
            <Link
              href={`/trending?category=${category}&metric=jpy`}
              aria-label="金額差ランキング"
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                metric === "jpy"
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              円
            </Link>
          </div>
        )}
        {category === "usage" && (
          <div className="flex gap-1">
            <Link
              href="/trending?category=usage&dir=up"
              aria-label="上昇ランキング"
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                usageDirection === "up"
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              上昇
            </Link>
            <Link
              href="/trending?category=usage&dir=down"
              aria-label="下降ランキング"
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                usageDirection === "down"
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              下降
            </Link>
          </div>
        )}
      </div>

      {rows.length > 0 ? (
        <WeeklyMoversList rows={rows} category={category} priceMetric={metric} />
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">
          まだ集計データがありません。しばらくしてから見に来てください。
        </p>
      )}
    </div>
  );
}
