"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { WeeklyMoverRow, MoverCategory } from "@/lib/dbWeeklyMovers";
import { formatLabelJa, FORMATS } from "@/lib/formats";
import RankingFilterPanel, {
  EMPTY_RANKING_FILTERS,
  GearIcon,
  matchesRankingFilters,
  type RankingFilters,
} from "@/components/RankingFilterPanel";

// 注目カードランキング（MlRankingList.tsx）と同様、フィルター機能を全ユーザーに開放する
// （2026-08-27、決済連携が未実装のため有料会員限定のまま塩漬けにしない方針）。
const UNLOCK_FILTERS = true;

function isFormat(v: string | null): v is (typeof FORMATS)[number] {
  return v !== null && (FORMATS as readonly string[]).includes(v);
}

// 1ページ5×4枚（グリッドの最大列数lg:grid-cols-5に合わせる）
const PAGE_SIZE = 20;

export default function WeeklyMoversList({
  rows,
  category,
  priceMetric,
}: {
  rows: WeeklyMoverRow[];
  category: MoverCategory;
  priceMetric: "pct" | "jpy";
}) {
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<RankingFilters>(EMPTY_RANKING_FILTERS);
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        matchesRankingFilters(filters, { formats: r.formats, colors: r.colors, rarity: r.rarity, priceJpy: r.priceJpy }),
      ),
    [rows, filters],
  );
  // フィルター/タブ切り替えで対象件数が変わったら1ページ目に戻す
  // （そうしないと、ページ数が減った状態で空のページを表示し続けてしまう）
  useEffect(() => setPage(0), [rows, filters]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-label="フィルター"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 text-neutral-500 hover:border-neutral-500 hover:text-neutral-700"
          >
            <GearIcon />
          </button>
          {showFilters && (
            <RankingFilterPanel
              filters={filters}
              onChange={setFilters}
              onClose={() => setShowFilters(false)}
              overrideLocked={UNLOCK_FILTERS ? false : undefined}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-5">
        {pageRows.map((row) => (
          <MoverRow key={row.oracleId} row={row} category={category} priceMetric={priceMetric} />
        ))}
      </div>
      {filtered.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">
          この条件に該当するカードはありません。
        </p>
      )}

      {pageCount > 1 && (
        <div className="flex justify-center gap-1.5">
          {Array.from({ length: pageCount }, (_, i) => i).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPage(p)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                p === page
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
              }`}
            >
              {p + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoverRow({
  row,
  category,
  priceMetric,
}: {
  row: WeeklyMoverRow;
  category: MoverCategory;
  priceMetric: "pct" | "jpy";
}) {
  const useJpy = category === "price" && priceMetric === "jpy";
  const changeText = useJpy
    ? `+¥${Math.round(row.changeValue).toLocaleString()}`
    : `+${row.changeValue.toFixed(1)}${category === "price" ? "%" : "pt"}`;
  // TrendingRankingList.tsxの「採用率(Format) +X.Xpt」表記に揃える
  const formatLabel = row.format ? (isFormat(row.format) ? formatLabelJa(row.format) : row.format) : null;
  return (
    <Link
      href={`/cards/${row.oracleId}`}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
    >
      <Image src={row.imageUrl} alt={row.nameEn} width={223} height={311} className="w-full object-contain" />
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">
          <span className="mr-1.5 text-neutral-400">{row.rank}</span>
          {row.nameJa}
        </p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>
        <p className="mt-1 text-sm font-semibold text-teal-800">
          {formatLabel && <span className="mr-1 font-normal text-neutral-500">{formatLabel}</span>}
          {changeText}
        </p>
        {row.priceJpy != null && row.priceJpy > 0 && (
          <p className="text-right text-sm">¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</p>
        )}
      </div>
    </Link>
  );
}
