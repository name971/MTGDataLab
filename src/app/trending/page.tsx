import Link from "next/link";
import { getWeeklyMovers, type MoverCategory } from "@/lib/dbWeeklyMovers";
import WeeklyMoversList from "@/components/WeeklyMoversList";

// 集計バッチ（compute-weekly-movers.mjs）は1日1回しか回らないため、長めにキャッシュする
export const revalidate = 21600;

export const metadata = { title: "週間ランキング - MTG DataLab" };

const CATEGORIES: { key: MoverCategory; label: string }[] = [
  { key: "price", label: "値上がりランキング" },
  { key: "usage", label: "採用率上昇ランキング" },
];

function resolveCategory(raw: string | undefined): MoverCategory {
  return raw === "usage" ? "usage" : "price";
}

function resolveMetric(raw: string | undefined): "pct" | "jpy" {
  return raw === "jpy" ? "jpy" : "pct";
}

export default async function TrendingRankingPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; metric?: string }>;
}) {
  const sp = await searchParams;
  const category = resolveCategory(sp.category);
  const metric = resolveMetric(sp.metric);

  // フィルター適用後にページが歯抜けにならないよう、Top100を全件まとめて取得し、
  // ページングはWeeklyMoversList.tsx（クライアント側、フィルター後の配列に対して）で行う
  // （MlRankingList.tsxと同じ方式、2026-08-27）。
  const { rows } = await getWeeklyMovers(category, metric);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">週間ランキング</h1>
        <p className="text-sm text-neutral-500">直近7日間の変化でTop100を毎日更新</p>
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
          <Link
            href={`/trending?category=price&metric=${metric === "jpy" ? "pct" : "jpy"}`}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 hover:border-neutral-500"
          >
            {metric === "jpy" ? "%ランキングに切替" : "金額差ランキングに切替"}
          </Link>
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
