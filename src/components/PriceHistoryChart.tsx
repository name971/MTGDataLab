"use client";

import { useMemo, useState } from "react";
import type { PricePoint } from "@/lib/dbPriceHistory";

type Period = "7" | "30" | "90" | "all";
const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: "7", label: "7日" },
  { key: "30", label: "30日" },
  { key: "90", label: "90日" },
  { key: "all", label: "全期間" },
];

const WIDTH = 600;
const HEIGHT = 280;
const PADDING = { top: 12, right: 12, bottom: 24, left: 56 };

export default function PriceHistoryChart({
  enHistory,
  jaHistory,
  enFoilHistory,
  jaFoilHistory,
  finish,
}: {
  enHistory: PricePoint[];
  jaHistory: PricePoint[];
  enFoilHistory: PricePoint[];
  jaFoilHistory: PricePoint[];
  /** 通常/Foilの切り替えはCardHero側の1箇所（価格表示と共通）で行うため、ここでは制御下で受け取るだけ */
  finish: "normal" | "foil";
}) {
  const [period, setPeriod] = useState<Period>("30");
  const [series, setSeries] = useState<"en" | "ja">("en");
  const hasJa = jaHistory.length > 0 || jaFoilHistory.length > 0;

  const normalHistory = series === "ja" && hasJa ? jaHistory : enHistory;
  const foilHistory = series === "ja" && hasJa ? jaFoilHistory : enFoilHistory;
  const fullHistory = finish === "foil" ? foilHistory : normalHistory;

  const points = useMemo(() => {
    if (period === "all") return fullHistory;
    const days = Number(period);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return fullHistory.filter((p) => p.date >= cutoffStr);
  }, [fullHistory, period]);

  const hasAnyData =
    enHistory.length > 0 || jaHistory.length > 0 || enFoilHistory.length > 0 || jaFoilHistory.length > 0;
  if (!hasAnyData) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-neutral-500">
        価格推移データがまだありません（日次スナップショットの蓄積待ち）。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setPeriod(opt.key)}
              className={`rounded-md border px-2 py-1 text-xs ${
                period === opt.key
                  ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {hasJa && (
            <div className="flex gap-1">
              {(["en", "ja"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeries(s)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    series === s
                      ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                      : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                  }`}
                >
                  {s === "en" ? "英語版" : "日本語版"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {fullHistory.length === 0 ? (
        <p className="py-6 text-center text-xs text-neutral-500">
          {finish === "foil" ? "この系列のFoil価格データはありません。" : "この系列の価格データはありません。"}
        </p>
      ) : points.length === 0 ? (
        <p className="py-6 text-center text-xs text-neutral-500">この期間のデータはありません。</p>
      ) : (
        <ChartSvg points={points} />
      )}
    </div>
  );
}

function ChartSvg({ points }: { points: PricePoint[] }) {
  const prices = points.map((p) => p.jpy);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  // 全部同じ価格の場合（点1つ等）にゼロ除算しないよう、上下に幅を持たせる
  const priceRange = maxPrice - minPrice || Math.max(maxPrice * 0.1, 1);
  const yFor = (jpy: number) =>
    PADDING.top +
    (1 - (jpy - (minPrice - priceRange * 0.1)) / (priceRange * 1.2)) * (HEIGHT - PADDING.top - PADDING.bottom);
  const xFor = (i: number) =>
    points.length === 1
      ? PADDING.left + (WIDTH - PADDING.left - PADDING.right) / 2
      : PADDING.left + (i / (points.length - 1)) * (WIDTH - PADDING.left - PADDING.right);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.jpy)}`).join(" ");
  const latest = points[points.length - 1];
  const first = points[0];
  const diff = latest.jpy - first.jpy;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full min-w-[400px]" role="img">
        <line
          x1={PADDING.left}
          y1={HEIGHT - PADDING.bottom}
          x2={WIDTH - PADDING.right}
          y2={HEIGHT - PADDING.bottom}
          className="stroke-neutral-200"
        />
        <text x={4} y={yFor(maxPrice) + 4} className="fill-neutral-400 text-[10px]">
          ¥{maxPrice.toLocaleString("ja-JP")}
        </text>
        <text x={4} y={yFor(minPrice) + 4} className="fill-neutral-400 text-[10px]">
          ¥{minPrice.toLocaleString("ja-JP")}
        </text>
        <path d={linePath} fill="none" className={diff >= 0 ? "stroke-teal-700" : "stroke-red-700"} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={p.date} cx={xFor(i)} cy={yFor(p.jpy)} r={2.5} className={diff >= 0 ? "fill-teal-700" : "fill-red-700"} />
        ))}
        <text x={PADDING.left} y={HEIGHT - 6} className="fill-neutral-400 text-[10px]">
          {first.date}
        </text>
        <text x={WIDTH - PADDING.right} y={HEIGHT - 6} textAnchor="end" className="fill-neutral-400 text-[10px]">
          {latest.date}
        </text>
      </svg>
    </div>
  );
}
