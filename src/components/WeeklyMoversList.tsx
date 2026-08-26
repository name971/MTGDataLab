"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
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

export default function WeeklyMoversList({
  rows,
  category,
}: {
  rows: WeeklyMoverRow[];
  category: MoverCategory;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<RankingFilters>(EMPTY_RANKING_FILTERS);
  const [showJpyDiff, setShowJpyDiff] = useState(false); // 値上がりランキングのみ、%⇔円表示切り替え

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        matchesRankingFilters(filters, { formats: r.formats, colors: r.colors, rarity: r.rarity, priceJpy: r.priceJpy }),
      ),
    [rows, filters],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {category === "price" && (
          <button
            type="button"
            onClick={() => setShowJpyDiff((v) => !v)}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 hover:border-neutral-500"
          >
            {showJpyDiff ? "%表示に切替" : "金額差で表示"}
          </button>
        )}
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
        {filtered.map((row) => (
          <MoverRow key={row.oracleId} row={row} category={category} showJpyDiff={showJpyDiff} />
        ))}
      </div>
      {filtered.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">
          この条件に該当するカードはありません。
        </p>
      )}
    </div>
  );
}

function MoverRow({
  row,
  category,
  showJpyDiff,
}: {
  row: WeeklyMoverRow;
  category: MoverCategory;
  showJpyDiff: boolean;
}) {
  const useJpy = category === "price" && showJpyDiff && row.changeValueJpy != null;
  const changeText = useJpy
    ? `+¥${Math.round(row.changeValueJpy!).toLocaleString()}`
    : `+${row.changeValue.toFixed(1)}${category === "price" ? "%" : "pt"}`;
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
        <div className="mt-1 flex items-center justify-between text-sm">
          <span className="font-semibold text-teal-800">{changeText}</span>
          {row.format && (
            <span className="truncate text-xs text-neutral-400">
              {isFormat(row.format) ? formatLabelJa(row.format) : row.format}
            </span>
          )}
        </div>
        {row.priceJpy != null && (
          <p className="text-right text-xs text-neutral-500">¥{row.priceJpy.toLocaleString()}</p>
        )}
      </div>
    </Link>
  );
}
