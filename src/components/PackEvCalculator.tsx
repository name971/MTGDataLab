"use client";

import Image from "next/image";
import { useMemo, useRef, useState } from "react";
import { calculatePackEv, type SampleSet } from "@/lib/samplePackData";
import { setNameJa } from "@/lib/packSetNamesJa";

type SortKey = "releasedAt" | "profit";
type ProductType = "play" | "collector";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "releasedAt", label: "発売日順" },
  { key: "profit", label: "お得度順" },
];

const PRODUCT_TYPE_OPTIONS: { key: ProductType; label: string }[] = [
  { key: "play", label: "Play Booster" },
  { key: "collector", label: "Collector Booster" },
];

export default function PackEvCalculator({
  playSets,
  collectorSets,
}: {
  playSets: SampleSet[];
  collectorSets: SampleSet[];
}) {
  const [productType, setProductType] = useState<ProductType>("play");
  const [sortKey, setSortKey] = useState<SortKey>("releasedAt");
  const sets = productType === "play" ? playSets : collectorSets;

  const evBySetCode = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sets) map.set(s.setCode, calculatePackEv(s));
    return map;
  }, [sets]);

  const profitBySetCode = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sets) map.set(s.setCode, (evBySetCode.get(s.setCode) ?? 0) - s.packPriceJpy);
    return map;
  }, [sets, evBySetCode]);

  const sorted = useMemo(() => {
    return [...sets].sort((a, b) =>
      sortKey === "releasedAt"
        ? b.releasedAt.localeCompare(a.releasedAt)
        : (profitBySetCode.get(b.setCode) ?? 0) - (profitBySetCode.get(a.setCode) ?? 0),
    );
  }, [sets, sortKey, profitBySetCode]);

  const maxDiff = Math.max(...sets.map((s) => (evBySetCode.get(s.setCode) ?? 0) - s.packPriceJpy));
  const minDiff = Math.min(...sets.map((s) => (evBySetCode.get(s.setCode) ?? 0) - s.packPriceJpy));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 border-b border-neutral-200 pb-3">
        {PRODUCT_TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setProductType(opt.key)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              productType === opt.key
                ? "border-neutral-800 bg-neutral-800 text-white"
                : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

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

      {sets.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">
          このカテゴリで算出できるセットがまだありません。
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {sorted.map((set) => (
          <PackCard
            key={set.setCode}
            set={set}
            ev={evBySetCode.get(set.setCode) ?? 0}
            diffHighlight={
              (evBySetCode.get(set.setCode) ?? 0) - set.packPriceJpy === maxDiff
                ? "max"
                : (evBySetCode.get(set.setCode) ?? 0) - set.packPriceJpy === minDiff
                  ? "min"
                  : null
            }
          />
        ))}
      </div>

      <p className="text-xs text-neutral-400">
        WotC公式排出率とレアリティ別平均価格（Scryfall/TCGCSV由来）から算出した参考値です。
      </p>
    </div>
  );
}

function PackCard({
  set,
  ev,
  diffHighlight,
}: {
  set: SampleSet;
  ev: number;
  diffHighlight: "max" | "min" | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const diff = ev - set.packPriceJpy;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-200">
      {set.packImageUrl && (
        <div className="relative aspect-[200/353] w-full bg-neutral-50">
          <Image src={set.packImageUrl} alt={set.setName} fill className="object-cover" />
        </div>
      )}
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">{setNameJa(set.setCode, set.setName)}</p>
        <p className="truncate text-xs text-neutral-500">{set.setName}</p>

        <div className="mt-1 flex items-start justify-between text-sm">
          <span className="flex flex-col">
            <span className="text-xs text-neutral-400">パック価格</span>
            <span className="font-numeric">¥{set.packPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</span>
          </span>
          <span className="flex flex-col items-end">
            <span className="text-xs text-neutral-400">期待値</span>
            <span className="font-numeric">¥{ev.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</span>
          </span>
        </div>

        <p
          className={`text-right text-sm ${
            diffHighlight === "max"
              ? "font-semibold text-red-600"
              : diffHighlight === "min"
                ? "font-semibold text-blue-600"
                : diff >= 0
                  ? "text-red-700"
                  : "text-blue-700"
          }`}
        >
          お得度{" "}
          <span className="font-numeric">
            {diff >= 0 ? "+" : ""}¥{diff.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
          </span>
        </p>

        <button
          onClick={() => dialogRef.current?.showModal()}
          className="mt-1 text-left text-xs text-neutral-400 underline hover:text-neutral-600"
        >
          内訳を見る
        </button>
      </div>

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialogRef.current?.close();
        }}
        className="m-auto w-[90vw] max-w-sm rounded-lg border border-neutral-200 p-0 backdrop:bg-black/50"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <h3 className="text-sm font-medium text-neutral-700">
            {setNameJa(set.setCode, set.setName)}の内訳
          </h3>
          <button
            onClick={() => dialogRef.current?.close()}
            aria-label="閉じる"
            className="rounded-full px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          {set.slots.map((slot) => (
            <div key={slot.slotName} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{slot.slotName}</span>
                <span className="shrink-0 text-neutral-500">
                  {slot.cardCount}枚 × ¥{slot.avgPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
                </span>
              </div>
              <p className="text-neutral-400">
                {Object.entries(slot.probabilityByRarity)
                  .map(([rarity, p]) => `${rarity} ${((p ?? 0) * 100).toFixed(1)}%`)
                  .join(" / ")}
                {slot.matchRate < 0.99 && (
                  <span className="ml-1 text-amber-600">（マッチ率{(slot.matchRate * 100).toFixed(1)}%）</span>
                )}
              </p>
            </div>
          ))}
        </div>
      </dialog>
    </div>
  );
}
