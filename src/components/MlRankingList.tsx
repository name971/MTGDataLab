"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { MlRankingRow } from "@/lib/dbMlRanking";
import RankingFilterPanel, {
  EMPTY_RANKING_FILTERS,
  GearIcon,
  matchesRankingFilters,
  type RankingFilters,
} from "@/components/RankingFilterPanel";

// 注目カードランキングのフォーマット/価格帯フィルターは有料会員限定から無料開放した
// （2026-08-27）。overrideLockedにfalseを渡し、実際の会員ステータスに関わらず常に
// ロックを外す。週間ランキング（WeeklyMoversList.tsx）は引き続き有料会員限定のまま。
const UNLOCK_FILTERS = true;

const PAGE_SIZE = 15;

const LADDER = [
  { pct: 5, key: "p5" as const },
  { pct: 10, key: "p10" as const },
  { pct: 15, key: "p15" as const },
  { pct: 20, key: "p20" as const },
];

export default function MlRankingList({
  up,
  down,
}: {
  up: MlRankingRow[];
  down: MlRankingRow[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

  // タブ/ページの状態をURLクエリに持たせる。カード詳細に遷移してブラウザで
  // 戻った時に見ていた状態のままにするため（クライアント側のuseStateだけだと、
  // 戻り時にこのコンポーネントが再マウントされて状態が失われていた）。
  const direction = searchParams.get("mlDir") === "down" ? "down" : "up";
  const page = Math.max(0, Number(searchParams.get("mlPage") ?? "0") || 0);
  const [filters, setFilters] = useState<RankingFilters>(EMPTY_RANKING_FILTERS);

  const allRows = direction === "up" ? up : down;
  const rows = useMemo(
    () =>
      allRows.filter((r) =>
        matchesRankingFilters(filters, { formats: r.formats, colors: r.colors, rarity: r.rarity, priceJpy: r.priceJpy }),
      ),
    [allRows, filters],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  function updateParams(next: { direction?: "up" | "down"; page?: number }) {
    const params = new URLSearchParams(searchParams.toString());
    const nextDirection = next.direction ?? direction;
    const nextPage = next.page ?? (next.direction ? 0 : page);
    if (nextDirection === "up") params.delete("mlDir");
    else params.set("mlDir", nextDirection);
    if (nextPage === 0) params.delete("mlPage");
    else params.set("mlPage", String(nextPage));
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => updateParams({ direction: "up" })}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
              direction === "up"
                ? "border-accent bg-accent-soft text-accent-text"
                : "border-neutral-300 text-neutral-700 hover:border-neutral-500"
            }`}
          >
            高騰予想
          </button>
          <button
            type="button"
            onClick={() => updateParams({ direction: "down" })}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
              direction === "down"
                ? "border-blue-600 bg-blue-50 text-blue-700"
                : "border-neutral-300 text-neutral-700 hover:border-neutral-500"
            }`}
          >
            暴落予想
          </button>
        </div>

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

      {/* モバイルでgrid-cols-3だと1カード116px程度まで狭まり、確率ラダーの4本の棒と
          ラベルが潰れて読めなくなっていた（2026-08-29、ユーザー指摘）。他のカードグリッド
          （継続注目カード等）と同じくモバイルは2列にする。 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 lg:grid-cols-5">
        {pageRows.map((row, index) => (
          <MlRankingCard
            key={row.oracleId}
            row={row}
            rank={page * PAGE_SIZE + index + 1}
            direction={direction}
          />
        ))}
      </div>

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => updateParams({ page: Math.max(0, page - 1) })}
            disabled={page === 0}
            className="rounded-md border border-neutral-300 px-3 py-1 disabled:opacity-40"
          >
            前へ
          </button>
          <span className="text-neutral-500">
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => updateParams({ page: Math.min(pageCount - 1, page + 1) })}
            disabled={page >= pageCount - 1}
            className="rounded-md border border-neutral-300 px-3 py-1 disabled:opacity-40"
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}

function MlRankingCard({
  row,
  rank,
  direction,
}: {
  row: MlRankingRow;
  rank: number;
  direction: "up" | "down";
}) {
  // カードそのものを見分けられることが重要なので、アートクロップではなくカード全体の画像を使う。
  // Scryfallの画像URLは/<バリエーション>/front/<...>.jpgという共通構造なので置換で導出できる。
  const normalImageUrl = row.artCropUrl.replace("/art_crop/", "/normal/");
  const barColor = direction === "up" ? "bg-emerald-500" : "bg-blue-500";
  const emphasisColor = direction === "up" ? "text-neutral-900" : "text-neutral-900";

  return (
    <Link
      href={`/cards/${row.oracleId}`}
      className="flex flex-col overflow-hidden rounded-2xl transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-neutral-200/60"
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
          <span className="mr-1.5 text-accent-text">{rank}</span>
          {row.nameJa}
        </p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>

        {/* 棒の高さ＝確率、棒の真下に「確率%」「+X%↑/↓」を2段で紐付けて、
            どの数字がどの閾値かを視線移動なしで対応させる（2026-08-16 ユーザーフィードバック）。
            「7日以内に値上がりする確率」の説明はセクション見出しのInfoTooltipに集約したので
            カードごとには表示しない。 */}
        <div className="mt-1 flex h-12 items-end gap-1.5">
          {LADDER.map(({ pct, key }) => (
            <div key={pct} className="flex h-full flex-1 flex-col items-center justify-end">
              <div
                className={`w-full rounded-t-sm ${row[key] >= 0.4 ? barColor : "bg-neutral-300"}`}
                style={{ height: `${Math.max(row[key] * 100, 4)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          {LADDER.map(({ pct, key }) => (
            <div key={pct} className="flex-1 text-center">
              <div
                className={`font-numeric text-xs font-semibold tabular-nums ${row[key] >= 0.4 ? emphasisColor : "text-neutral-500"}`}
              >
                {Math.round(row[key] * 100)}%
              </div>
              {/* 薄すぎて読めないという指摘（2026-08-29）を受けneutral-400→600、続けて
                  日本の相場表記に合わせ上昇=赤・下降=青に（同日） */}
              <div className={`font-numeric text-[10px] ${direction === "up" ? "text-red-700" : "text-blue-700"}`}>
                {direction === "up" ? "+" : "-"}
                {pct}%{direction === "up" ? "↑" : "↓"}
              </div>
            </div>
          ))}
        </div>

        {/* 予測時点(calculated_at)から今どれだけ動いたか。バッチ
            （scripts/update-ml-prediction-outcomes.mjs）が未実行/価格履歴が無い分はnull
            になるため、その場合はバッジを出さず価格だけ表示する（ArtifactモックのC9案、
            2026-08-29採用）。 */}
        <div className="flex items-baseline justify-end gap-1 overflow-hidden">
          <span className="font-numeric shrink-0 text-sm font-semibold">
            ¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
          </span>
          {row.currentPctChange != null && (
            <span
              title="予測時点からの現時点での変化率"
              className={`font-numeric shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                row.currentPctChange >= 0 ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"
              }`}
            >
              {row.currentPctChange >= 0 ? "+" : ""}
              {row.currentPctChange.toFixed(1)}%
            </span>
          )}
          {row.extremePctChange != null && (
            <span
              title="予測時点から今日までの間で一番良かった結果"
              className="font-numeric shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-bold text-neutral-500"
            >
              MAX{row.extremePctChange >= 0 ? "+" : ""}
              {row.extremePctChange.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

