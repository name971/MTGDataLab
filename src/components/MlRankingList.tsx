"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FORMATS } from "@/lib/formats";
import { createClient } from "@/lib/supabase/client";
import type { MlRankingRow } from "@/lib/dbMlRanking";

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

  const rows = direction === "up" ? up : down;
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
            className={`rounded-md border px-3 py-1.5 text-sm ${
              direction === "up"
                ? "border-neutral-800 bg-neutral-800 text-white"
                : "border-neutral-300 text-neutral-700 hover:border-neutral-500"
            }`}
          >
            急騰予想
          </button>
          <button
            type="button"
            onClick={() => updateParams({ direction: "down" })}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              direction === "down"
                ? "border-neutral-800 bg-neutral-800 text-white"
                : "border-neutral-300 text-neutral-700 hover:border-neutral-500"
            }`}
          >
            急落予想
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
          {showFilters && <FilterPanel onClose={() => setShowFilters(false)} />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-5">
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
                className={`text-xs font-semibold tabular-nums ${row[key] >= 0.4 ? emphasisColor : "text-neutral-500"}`}
              >
                {Math.round(row[key] * 100)}%
              </div>
              <div className="text-[10px] text-neutral-400">
                {direction === "up" ? "+" : "-"}
                {pct}%{direction === "up" ? "↑" : "↓"}
              </div>
            </div>
          ))}
        </div>

        <p className="text-right text-sm">
          ¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
        </p>
      </div>
    </Link>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** フォーマット/価格帯/確率しきい値フィルターのUI。会員登録（Supabase Auth+Google）は
    実装済みだが決済連携は未実装のため、is_premiumを手動でtrueにしない限り常にロック
    表示になる（有料会員機能として後日、決済連携時にis_premiumを自動更新する想定）。
    実際の絞り込みロジック自体もまだ未実装（UIのみ）。 */
function FilterPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<"loading" | "anonymous" | "free" | "premium">("loading");
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        setStatus("anonymous");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_premium")
        .eq("id", data.user.id)
        .single();
      setStatus(profile?.is_premium ? "premium" : "free");
    });
  }, [supabase]);

  const locked = status !== "premium";

  return (
    <div className="absolute right-0 top-9 z-10 w-72 rounded-md border border-neutral-200 bg-white p-3 shadow-md">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium">絞り込み</p>
        <button type="button" onClick={onClose} className="text-xs text-neutral-400 hover:text-neutral-600">
          閉じる
        </button>
      </div>

      <div className="relative">
        <div className={`space-y-3 ${locked ? "pointer-events-none opacity-50" : ""}`}>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">フォーマット</label>
            <select disabled className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
              <option>すべて</option>
              {FORMATS.map((format) => (
                <option key={format}>{format}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">価格帯</label>
            <div className="flex items-center gap-2">
              <input
                disabled
                type="number"
                placeholder="下限"
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
              <span className="text-neutral-400">〜</span>
              <input
                disabled
                type="number"
                placeholder="上限"
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">確率のしきい値</label>
            <select disabled className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
              <option>+5%以上が◯%以上</option>
              <option>+10%以上が◯%以上</option>
              <option>+15%以上が◯%以上</option>
              <option>+20%以上が◯%以上</option>
            </select>
          </div>
        </div>

        {status !== "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-md bg-white/70 text-center">
            <LockIcon />
            <p className="text-xs font-medium text-neutral-700">有料会員限定機能</p>
            <p className="px-4 text-[11px] text-neutral-500">
              {status === "anonymous"
                ? "ログインすると詳細が確認できます"
                : "近日提供予定です"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-neutral-400"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
