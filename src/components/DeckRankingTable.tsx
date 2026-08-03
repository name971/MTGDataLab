"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { ArchetypeRow } from "@/lib/sampleDeckData";

type SortKey = "usageRatePct" | "medianPriceJpy";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "usageRatePct", label: "採用率順" },
  { key: "medianPriceJpy", label: "平均価格順" },
];

const VISIBLE_COUNT = 25;
const PRICE_HIGHLIGHT_WINDOW = 10;

export default function DeckRankingTable({ rows }: { rows: ArchetypeRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("usageRatePct");
  const [expanded, setExpanded] = useState(false);
  // StandardのみarenaMedianPriceJpyが付く（dbArchetypeStats.ts参照）。それ以外のフォーマットでは
  // 全行undefinedなので、チェックボックス自体を出さない。
  const hasArenaData = rows.some((r) => r.arenaMedianPriceJpy !== undefined);
  const [arenaMode, setArenaMode] = useState(false);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => b[sortKey] - a[sortKey]),
    [rows, sortKey],
  );
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);

  const displayPrice = (r: ArchetypeRow) =>
    arenaMode && r.arenaMedianPriceJpy !== undefined ? r.arenaMedianPriceJpy : r.medianPriceJpy;

  // 上位10件（表示件数に関わらずこの10件固定）の中で中央値価格が最大・最小のものを色分けする
  const top10 = sorted.slice(0, PRICE_HIGHLIGHT_WINDOW);
  const maxPriceArchetypeId =
    top10.length > 0
      ? top10.reduce((max, r) => (displayPrice(r) > displayPrice(max) ? r : max)).archetypeId
      : null;
  const minPriceArchetypeId =
    top10.length > 0
      ? top10.reduce((min, r) => (displayPrice(r) < displayPrice(min) ? r : min)).archetypeId
      : null;

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
        {hasArenaData && (
          <label
            title="ワイルドカード換算：レア¥1,500/4枚、神話レア¥3,000/4枚、コモン・アンコモン¥0"
            className="ml-auto flex w-fit cursor-help items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600"
          >
            <input
              type="checkbox"
              checked={arenaMode}
              onChange={(e) => setArenaMode(e.target.checked)}
              className="h-4 w-4"
            />
            MTG Arena換算で表示
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {visible.map((row) => (
          <ArchetypeCard
            key={row.archetypeId}
            row={row}
            displayPriceJpy={displayPrice(row)}
            priceHighlight={
              row.archetypeId === maxPriceArchetypeId
                ? "max"
                : row.archetypeId === minPriceArchetypeId
                  ? "min"
                  : null
            }
          />
        ))}
      </div>

      {sorted.length > VISIBLE_COUNT && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="self-center rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:border-neutral-500"
        >
          {expanded ? "閉じる" : `もっと見る（残り${sorted.length - VISIBLE_COUNT}件）`}
        </button>
      )}
    </div>
  );
}

function ArchetypeCard({
  row,
  displayPriceJpy,
  priceHighlight,
}: {
  row: ArchetypeRow;
  displayPriceJpy: number;
  priceHighlight: "max" | "min" | null;
}) {
  // archetypeIdが数字ならDB由来（archetypes.id）、それ以外は旧サンプルデータのスラグ。
  // DB由来のidは実デッキのidと数字が衝突しうるので/decks/[deckId]には出さない。
  const href = /^\d+$/.test(row.archetypeId)
    ? `/decks/archetype/${row.archetypeId}`
    : `/decks/${row.archetypeId}`;

  return (
    <Link
      href={href}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
    >
      {/* aspect-[4/3]だと、中の<img>の実サイズによってはflexboxの内容依存サイジングが
          優先されて縦横比が崩れることがあるため、padding-topトリックで高さを幅から確実に固定する */}
      <div className="relative w-full overflow-hidden pt-[75%]">
        {row.representativeArtUrls && row.representativeArtUrls.length === 2 ? (
          <div className="absolute inset-0 flex">
            {row.representativeArtUrls.map((url, i) => (
              <Image
                key={i}
                src={url}
                alt=""
                width={140}
                height={210}
                className="h-full w-1/2 object-cover"
              />
            ))}
          </div>
        ) : row.representativeArtUrl ? (
          <Image
            src={row.representativeArtUrl}
            alt=""
            width={280}
            height={210}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 text-xs text-neutral-400">
            画像なし
          </div>
        )}
        {row.colors && row.colors.length > 0 && (
          <div className="absolute bottom-1.5 right-1.5 flex gap-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
            {row.colors.map((c) => (
              <Image key={c} src={`/mana/${c}.svg`} alt={c} width={28} height={28} className="h-7 w-7" />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">{row.nameJa}</p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>
        <div className="mt-1 flex items-start justify-between text-sm">
          <span className="flex flex-col">
            <span className="text-xs text-neutral-400">採用率</span>
            <span className="text-neutral-600">{row.usageRatePct.toFixed(1)}%</span>
          </span>
          <span className="flex flex-col items-end">
            <span className="text-xs text-neutral-400">中央値価格</span>
            <span
              className={
                priceHighlight === "max"
                  ? "font-semibold text-red-600"
                  : priceHighlight === "min"
                    ? "font-semibold text-blue-600"
                    : ""
              }
            >
              ¥{displayPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
}
