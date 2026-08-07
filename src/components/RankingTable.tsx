"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { RankingRow } from "@/lib/sampleRankingData";

/**
 * 取引量は無料データソースが存在しないため launch では対象外（docs/spec.md 2章）。
 * 価格・採用率の2軸のみで運用する。
 */
type SortKey = "priceChangePct" | "usageRatePct";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "usageRatePct", label: "採用率" },
  { key: "priceChangePct", label: "値上がり率" },
];

const COLOR_FILTER_OPTIONS = ["W", "U", "B", "R", "G"] as const;
const VISIBLE_COUNT = 20;

export default function RankingTable({ rows }: { rows: RankingRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("usageRatePct");
  const [colorFilter, setColorFilter] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (colorFilter.size === 0) return rows;
    // 選択した色の組み合わせと完全一致するカードだけを出す（黒単選択なら黒単のみ、
    // 黒青選択なら黒と青の両方を持つ2色カードのみで、黒単・青単・3色以上は含まない）
    return rows.filter(
      (r) => r.colors && r.colors.length === colorFilter.size && r.colors.every((c) => colorFilter.has(c)),
    );
  }, [rows, colorFilter]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, VISIBLE_COUNT),
    [filtered, sortKey],
  );

  const maxPrice = Math.max(...sorted.map((r) => r.priceJpy));
  const minPrice = Math.min(...sorted.map((r) => r.priceJpy));

  // 採用率はフォーマットによって分布が全く違う（Standardは上位40%前後、Commanderは
  // 統率者以外だと数%）ので、絶対値の閾値ではなく表示中のリスト内での相対順位（上位/中位/下位）
  // で3段階に色分けする。
  const usageTiersByOracleId = useMemo(() => {
    const n = sorted.length;
    const descRates = [...sorted.map((r) => r.usageRatePct)].sort((a, b) => b - a);
    const highThreshold = descRates[Math.max(0, Math.ceil(n / 3) - 1)] ?? 0;
    const midThreshold = descRates[Math.max(0, Math.ceil((2 * n) / 3) - 1)] ?? 0;
    const map = new Map<string, "high" | "mid" | "low">();
    for (const r of sorted) {
      map.set(
        r.oracleId,
        r.usageRatePct >= highThreshold ? "high" : r.usageRatePct >= midThreshold ? "mid" : "low",
      );
    }
    return map;
  }, [sorted]);

  function toggleColor(c: string) {
    setColorFilter((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortKey(opt.key)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                sortKey === opt.key
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 border-l border-neutral-200 pl-2">
          {COLOR_FILTER_OPTIONS.map((c) => (
            <button
              key={c}
              onClick={() => toggleColor(c)}
              aria-pressed={colorFilter.has(c)}
              className={`rounded-full p-0.5 ${
                colorFilter.has(c) ? "bg-neutral-200 ring-2 ring-neutral-400" : "opacity-50 hover:opacity-100"
              }`}
            >
              <Image src={`/mana/${c}.svg`} alt={c} width={22} height={22} className="h-[22px] w-[22px]" />
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-5">
        {sorted.map((row, index) => (
          <CardRankRow
            key={row.oracleId}
            row={row}
            rank={index + 1}
            priceHighlight={
              row.priceJpy === maxPrice ? "max" : row.priceJpy === minPrice ? "min" : null
            }
            usageTier={usageTiersByOracleId.get(row.oracleId) ?? "low"}
          />
        ))}
      </div>
      {sorted.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">
          この色の組み合わせに該当するカードはありません。
        </p>
      )}
    </div>
  );
}

const USAGE_TIER_CLASS: Record<"high" | "mid" | "low", string> = {
  high: "text-teal-700 font-semibold",
  mid: "text-neutral-600",
  low: "text-neutral-400",
};

function CardRankRow({
  row,
  rank,
  priceHighlight,
  usageTier,
}: {
  row: RankingRow;
  rank: number;
  priceHighlight: "max" | "min" | null;
  usageTier: "high" | "mid" | "low";
}) {
  // カードそのものを見分けられることが重要なので、アートクロップではなくカード全体の画像を使う。
  // Scryfallの画像URLは/<バリエーション>/front/<...>.jpgという共通構造なので置換で導出できる。
  const normalImageUrl = row.artCropUrl.replace("/art_crop/", "/normal/");

  return (
    <Link
      href={`/cards/${row.oracleId}`}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
    >
      <Image
        src={normalImageUrl}
        alt={row.nameEn}
        width={223}
        height={311}
        className="w-full object-contain"
      />
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">
          <span className="mr-1.5 text-neutral-400">{rank}</span>
          {row.nameJa}
        </p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>
        <div className="mt-1 flex items-start justify-between text-sm">
          <span className="flex flex-col">
            <span className="whitespace-nowrap text-[10px] text-neutral-400">価格上昇率</span>
            <span className={row.priceChangePct >= 0 ? "text-teal-800" : "text-red-800"}>
              {row.priceChangePct >= 0 ? "+" : ""}
              {row.priceChangePct.toFixed(1)}%
            </span>
          </span>
          <span className="flex flex-col items-end">
            <span className="whitespace-nowrap text-[10px] text-neutral-400">採用率</span>
            <span className={USAGE_TIER_CLASS[usageTier]}>{row.usageRatePct.toFixed(1)}%</span>
          </span>
        </div>
        <p
          className={`text-right text-sm ${
            priceHighlight === "max"
              ? "font-semibold text-red-600"
              : priceHighlight === "min"
                ? "font-semibold text-blue-600"
                : ""
          }`}
        >
          ¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
        </p>
      </div>
    </Link>
  );
}
