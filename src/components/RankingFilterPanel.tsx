"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { useIsPremium } from "@/lib/useIsPremium";
import { FORMATS, formatLabelJa } from "@/lib/formats";
import { COLOR_ORDER } from "@/lib/manaColors";
import { RARITIES } from "@/lib/parseAdvancedSearchParams";
import { RARITY_LABEL_JA } from "@/lib/scryfall";

export interface RankingFilters {
  formats: string[]; // 空配列 = すべて（複数選択、OR条件）
  colors: string[]; // 空配列 = すべて（選択した色構成と完全一致するカードのみ、RankingTable.tsxと同じ判定基準）
  rarities: string[]; // 空配列 = すべて（複数選択、OR条件）
  priceMin: number | null;
  priceMax: number | null;
}

export const EMPTY_RANKING_FILTERS: RankingFilters = {
  formats: [],
  colors: [],
  rarities: [],
  priceMin: null,
  priceMax: null,
};

function toNumberOrNull(value: string): number | null {
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** フォーマット/価格帯フィルターの絞り込みUI。有料会員限定機能（決済連携は未実装のため
 * is_premiumを手動でtrueにしない限り常にロック表示）。MlRankingList.tsx・
 * WeeklyMoversList.tsxの両方から共有する。
 *
 * overrideLockedはテスト時にロックを一時的に外して絞り込みロジック自体を確認するための
 * デバッグ用途（本番では渡さない＝useIsPremiumの実際の会員ステータスに従う）。 */
export default function RankingFilterPanel({
  filters,
  onChange,
  onClose,
  extra,
  overrideLocked,
}: {
  filters: RankingFilters;
  onChange: (next: RankingFilters) => void;
  onClose: () => void;
  extra?: ReactNode;
  overrideLocked?: boolean;
}) {
  const status = useIsPremium();
  const locked = overrideLocked ?? status !== "premium";
  // overrideLocked指定時（テスト用）はstatusの読み込み待ちを無視して即座に判定する
  const showLockOverlay = overrideLocked !== undefined ? locked : locked && status !== "loading";

  function toggleFormat(format: string) {
    const next = filters.formats.includes(format)
      ? filters.formats.filter((f) => f !== format)
      : [...filters.formats, format];
    onChange({ ...filters, formats: next });
  }

  function toggleColor(color: string) {
    const next = filters.colors.includes(color)
      ? filters.colors.filter((c) => c !== color)
      : [...filters.colors, color];
    onChange({ ...filters, colors: next });
  }

  function toggleRarity(rarity: string) {
    const next = filters.rarities.includes(rarity)
      ? filters.rarities.filter((r) => r !== rarity)
      : [...filters.rarities, rarity];
    onChange({ ...filters, rarities: next });
  }

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
            <label className="mb-1 block text-xs text-neutral-500">
              フォーマット{filters.formats.length > 0 && `（${filters.formats.length}件選択中）`}
            </label>
            <div className="flex flex-wrap gap-1">
              {FORMATS.map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => toggleFormat(format)}
                  aria-pressed={filters.formats.includes(format)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    filters.formats.includes(format)
                      ? "border-neutral-700 bg-neutral-800 text-white"
                      : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
                  }`}
                >
                  {formatLabelJa(format)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">色</label>
            <div className="flex gap-1">
              {COLOR_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleColor(c)}
                  aria-pressed={filters.colors.includes(c)}
                  className={`rounded-full p-0.5 ${
                    filters.colors.includes(c) ? "bg-neutral-200 ring-2 ring-neutral-400" : "opacity-50 hover:opacity-100"
                  }`}
                >
                  <Image src={`/mana/${c}.svg`} alt={c} width={22} height={22} className="h-[22px] w-[22px]" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">
              レアリティ{filters.rarities.length > 0 && `（${filters.rarities.length}件選択中）`}
            </label>
            <div className="flex flex-wrap gap-1">
              {RARITIES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => toggleRarity(r)}
                  aria-pressed={filters.rarities.includes(r)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    filters.rarities.includes(r)
                      ? "border-neutral-700 bg-neutral-800 text-white"
                      : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
                  }`}
                >
                  {RARITY_LABEL_JA[r]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">価格帯（円）</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="下限"
                value={filters.priceMin ?? ""}
                onChange={(e) => onChange({ ...filters, priceMin: toNumberOrNull(e.target.value) })}
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
              <span className="text-neutral-400">〜</span>
              <input
                type="number"
                placeholder="上限"
                value={filters.priceMax ?? ""}
                onChange={(e) => onChange({ ...filters, priceMax: toNumberOrNull(e.target.value) })}
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          {extra}
        </div>

        {showLockOverlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-md bg-white/70 text-center">
            <LockIcon />
            <p className="text-xs font-medium text-neutral-700">有料会員限定機能</p>
            <p className="px-4 text-[11px] text-neutral-500">
              {status === "anonymous" ? "ログインすると詳細が確認できます" : "近日提供予定です"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export function GearIcon() {
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

/** フィルターがカードに適用可能かどうかの共通判定。フォーマットは選択した中のどれか1つでも
 * カードの使用フォーマットに含まれていればOK（OR条件）。色は選択した色構成と完全一致
 * するカードのみ（RankingTable.tsx・WeeklyMoversList.tsxの旧実装と同じ判定基準、黒単選択
 * なら黒単のみ、黒青選択なら黒と青の両方を持つ2色カードのみで単色・3色以上は含まない）。
 * 価格帯フィルターはpriceJpyがnullなら対象外にしない（データが無いカードを一律で
 * 除外しないための緩い扱い）。 */
export function matchesRankingFilters(
  filters: RankingFilters,
  card: { formats: string[]; colors: string[]; rarity?: string | null; priceJpy: number | null },
): boolean {
  if (filters.formats.length > 0 && !card.formats.some((f) => filters.formats.includes(f))) return false;
  if (
    filters.colors.length > 0 &&
    !(card.colors.length === filters.colors.length && card.colors.every((c) => filters.colors.includes(c)))
  ) {
    return false;
  }
  if (filters.rarities.length > 0 && card.rarity != null && !filters.rarities.includes(card.rarity)) return false;
  if (filters.priceMin != null && card.priceJpy != null && card.priceJpy < filters.priceMin) return false;
  if (filters.priceMax != null && card.priceJpy != null && card.priceJpy > filters.priceMax) return false;
  return true;
}
