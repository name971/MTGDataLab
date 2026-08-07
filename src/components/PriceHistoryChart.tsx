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

/** sets.icon_svg_uri（正しいURL）が無ければ、大半のセットで成り立つ命名規則にフォールバックする */
function setIconUrl(setCode: string, iconUrlBySetCode: Record<string, string>): string {
  return iconUrlBySetCode[setCode] ?? `https://svgs.scryfall.io/sets/${setCode}.svg`;
}

export default function PriceHistoryChart({
  enHistory,
  enFoilHistory,
  finish,
  iconUrlBySetCode,
}: {
  enHistory: PricePoint[];
  enFoilHistory: PricePoint[];
  /** 通常/Foilの切り替えはCardHero側の1箇所（価格表示と共通）で行うため、ここでは制御下で受け取るだけ */
  finish: "normal" | "foil";
  /** set_code -> Scryfallの正しいセットシンボル画像URL（CardHero.tsx参照） */
  iconUrlBySetCode: Record<string, string>;
}) {
  const [period, setPeriod] = useState<Period>("30");

  const fullHistory = finish === "foil" ? enFoilHistory : enHistory;

  const points = useMemo(() => {
    if (period === "all") return fullHistory;
    const days = Number(period);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return fullHistory.filter((p) => p.date >= cutoffStr);
  }, [fullHistory, period]);

  const hasAnyData = enHistory.length > 0 || enFoilHistory.length > 0;
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
      </div>

      {fullHistory.length === 0 ? (
        <p className="py-6 text-center text-xs text-neutral-500">
          {finish === "foil" ? "この系列のFoil価格データはありません。" : "この系列の価格データはありません。"}
        </p>
      ) : points.length === 0 ? (
        <p className="py-6 text-center text-xs text-neutral-500">この期間のデータはありません。</p>
      ) : (
        <ChartSvg points={points} iconUrlBySetCode={iconUrlBySetCode} />
      )}
    </div>
  );
}

function ChartSvg({
  points,
  iconUrlBySetCode,
}: {
  points: PricePoint[];
  iconUrlBySetCode: Record<string, string>;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  // マウス位置に一番近い点を探す（点の間隔がまばらでも操作しやすいよう、X座標だけで判定する）
  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relativeX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(xFor(i) - relativeX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHoverIndex(closest);
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.jpy)}`).join(" ");
  const latest = points[points.length - 1];
  const first = points[0];
  const diff = latest.jpy - first.jpy;
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  // ツールチップがSVGの右端で見切れないよう、カーソルに近い点が右寄りなら吹き出しを左側に出す
  const tooltipAnchorsRight = hoverIndex !== null && xFor(hoverIndex) > WIDTH * 0.6;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full min-w-[400px]"
        role="img"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
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
          <circle
            key={`dot-${p.date}`}
            cx={xFor(i)}
            cy={yFor(p.jpy)}
            r={hoverIndex === i ? 4 : 2.5}
            className={diff >= 0 ? "fill-teal-700" : "fill-red-700"}
          />
        ))}
        {points.map((p, i) => {
          // 最安のセットが前日から変わっていない間は同じアイコンが点ごとに連続してしまい
          // 潰れて見えるため、セットが切り替わった点にだけ表示する（切り替わりが伝われば十分）。
          if (!p.setCode || p.setCode === points[i - 1]?.setCode) return null;
          const size = hoverIndex === i ? 24 : 20;
          return (
            <image
              key={`icon-${p.date}`}
              href={setIconUrl(p.setCode, iconUrlBySetCode)}
              x={xFor(i) - size / 2}
              y={yFor(p.jpy) - size - 10}
              width={size}
              height={size}
              // Scryfallにアイコンが無いセット（GK1等の一部）だと画像が壊れて見えるため、
              // 読み込み失敗時は自前の汎用スパークルアイコンに差し替える。
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.setAttribute("href", "/icons/no-set-symbol.svg");
              }}
            />
          );
        })}
        <text x={PADDING.left} y={HEIGHT - 6} className="fill-neutral-400 text-[10px]">
          {first.date}
        </text>
        <text x={WIDTH - PADDING.right} y={HEIGHT - 6} textAnchor="end" className="fill-neutral-400 text-[10px]">
          {latest.date}
        </text>

        {hovered &&
          (() => {
            const TOOLTIP_WIDTH = 176;
            const TOOLTIP_HEIGHT = hovered.setCode ? 58 : 42;
            const MAX_SET_NAME_CHARS = 20;
            const rawSetName = hovered.setName ?? hovered.setCode ?? "";
            const setName =
              rawSetName.length > MAX_SET_NAME_CHARS
                ? `${rawSetName.slice(0, MAX_SET_NAME_CHARS)}…`
                : rawSetName;
            return (
              <g pointerEvents="none">
                <line
                  x1={xFor(hoverIndex!)}
                  y1={PADDING.top}
                  x2={xFor(hoverIndex!)}
                  y2={HEIGHT - PADDING.bottom}
                  className="stroke-neutral-300"
                  strokeDasharray="3 3"
                />
                <circle cx={xFor(hoverIndex!)} cy={yFor(hovered.jpy)} r={4} className="fill-white stroke-neutral-700" strokeWidth={1.5} />
                <g
                  transform={`translate(${xFor(hoverIndex!) + (tooltipAnchorsRight ? -(TOOLTIP_WIDTH + 8) : 8)}, ${Math.max(PADDING.top, yFor(hovered.jpy) - TOOLTIP_HEIGHT / 2 - 10)})`}
                >
                  <rect width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT} rx={4} className="fill-neutral-800" opacity={0.92} />
                  {hovered.setCode && (
                    <>
                      <image
                        href={setIconUrl(hovered.setCode, iconUrlBySetCode)}
                        x={10}
                        y={9}
                        width={15}
                        height={15}
                        className="invert"
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.setAttribute("href", "/icons/no-set-symbol.svg");
                        }}
                      />
                      <text x={30} y={20} className="fill-neutral-300 text-[11px]">
                        {setName}
                      </text>
                    </>
                  )}
                  <text x={10} y={hovered.setCode ? 40 : 17} className="fill-white text-[13px] font-medium">
                    ¥{hovered.jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                  </text>
                  <text x={10} y={hovered.setCode ? 53 : 33} className="fill-neutral-300 text-[11px]">
                    {hovered.date}
                  </text>
                </g>
              </g>
            );
          })()}
      </svg>
    </div>
  );
}
