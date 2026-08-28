"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

// 1ページ5×4枚（グリッドの最大列数lg:grid-cols-5に合わせる）
const PAGE_SIZE = 20;

/** フィルター/ページの状態をURLクエリに持たせる（MlRankingList.tsxと同じ理由）。
 * カード詳細ページに遷移してブラウザで戻ると、この状態がuseStateだけだと初期化されて
 * しまう（この画面自体がアンマウントされるため）。URLに乗せておけば、戻った時に同じURLへ
 * 戻ってくることで状態が復元される（2026-08-27、ユーザー指摘）。 */
function parseFiltersFromParams(sp: URLSearchParams): RankingFilters {
  const csv = (key: string) => {
    const v = sp.get(key);
    return v ? v.split(",").filter(Boolean) : [];
  };
  const num = (key: string) => {
    const v = sp.get(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    formats: csv("wmFormats"),
    colors: csv("wmColors"),
    rarities: csv("wmRarities"),
    priceMin: num("wmPriceMin"),
    priceMax: num("wmPriceMax"),
  };
}

export default function WeeklyMoversList({
  rows,
  category,
  priceMetric,
}: {
  rows: WeeklyMoverRow[];
  category: MoverCategory;
  priceMetric: "pct" | "jpy";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

  const filters = useMemo(() => parseFiltersFromParams(searchParams), [searchParams]);
  const page = Math.max(0, Number(searchParams.get("wmPage") ?? "0") || 0);

  function updateParams(next: { filters?: RankingFilters; page?: number }) {
    const params = new URLSearchParams(searchParams.toString());
    const nextFilters = next.filters ?? filters;
    const setOrDelete = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
    setOrDelete("wmFormats", nextFilters.formats.join(","));
    setOrDelete("wmColors", nextFilters.colors.join(","));
    setOrDelete("wmRarities", nextFilters.rarities.join(","));
    setOrDelete("wmPriceMin", nextFilters.priceMin != null ? String(nextFilters.priceMin) : "");
    setOrDelete("wmPriceMax", nextFilters.priceMax != null ? String(nextFilters.priceMax) : "");
    // フィルターを変更したら1ページ目に戻す（そうしないと、ページ数が減った状態で
    // 空のページを表示し続けてしまう）
    const nextPage = next.page ?? (next.filters ? 0 : page);
    if (nextPage === 0) params.delete("wmPage");
    else params.set("wmPage", String(nextPage));
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        matchesRankingFilters(filters, { formats: r.formats, colors: r.colors, rarity: r.rarity, priceJpy: r.priceJpy }),
      ),
    [rows, filters],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // カテゴリ/指標タブの切り替えはwmPageを更新せずURLごと差し替えるため、切り替え先の
  // 件数が現在のページ番号より少ないと範囲外になりうる。範囲外でも「該当カードなし」には
  // 該当しない（filtered.length>0のため）ので、無言で空白のグリッドになってしまう
  // （2026-08-27、ユーザー指摘の「％タブでバグる」の原因）。表示直前でクランプする。
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

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
              onChange={(next) => updateParams({ filters: next })}
              onClose={() => setShowFilters(false)}
              overrideLocked={UNLOCK_FILTERS ? false : undefined}
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-5">
        {pageRows.map((row) => (
          <MoverRow key={row.scryfallId ?? row.oracleId} row={row} category={category} priceMetric={priceMetric} />
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
              onClick={() => updateParams({ page: p })}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                p === clampedPage
                  ? "border-accent bg-accent-soft text-accent-text"
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
  // priceMetric/print等は値上がりのみ扱うため常に正だが、採用率下降ランキングは
  // change_valueが負になる。符号は数値側にすでに乗っているので、正の時だけ"+"を足す
  // （toFixedは負数ならそのまま"-"付きの文字列になる）。
  const sign = row.changeValue >= 0 ? "+" : "";
  const changeText = useJpy
    ? `${sign}¥${Math.round(row.changeValue).toLocaleString()}`
    : `${sign}${row.changeValue.toFixed(1)}${category === "usage" ? "pt" : "%"}`;
  // TrendingRankingList.tsxの「採用率(Format) +X.Xpt」表記に揃える
  const formatLabel = row.format
    ? (isFormat(row.format) ? formatLabelJa(row.format) : row.format)
    : row.finish === "foil"
      ? "Foil"
      : row.finish === "nonfoil"
        ? "通常"
        : null;
  // カード詳細ページ（その他プリント・使用デッキ欄あり）へ飛ばし、動いたプリント自体を
  // 最初から選択済みにする（プリント詳細ページ単体はその他プリント・使用デッキ欄が無く
  // 情報量で劣るという指摘のため、2026-08-27）。
  const href = row.scryfallId
    ? `/cards/${row.oracleId}?print=${row.scryfallId}${row.finish === "foil" ? "&finish=foil" : ""}`
    : `/cards/${row.oracleId}`;
  return (
    <Link
      href={href}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
    >
      <div className="relative">
        <Image src={row.imageUrl} alt={row.nameEn} width={223} height={311} className="w-full object-contain" />
        {row.finish === "foil" && (
          // CardHero.tsxと同じ虹色ホログラム風テクスチャ（実物のFoilカードの質感を模した演出）
          <div
            className="pointer-events-none absolute inset-0 opacity-50 mix-blend-overlay"
            style={{
              background:
                "repeating-linear-gradient(115deg, #ff0080 0%, #ff8c00 14%, #ffed00 28%, #00ff8c 42%, #00c8ff 56%, #8c00ff 70%, #ff0080 84%)",
              backgroundSize: "200% 200%",
            }}
          />
        )}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">
          <span className="mr-1.5 text-accent-text">{row.rank}</span>
          {row.nameJa}
        </p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>
        <p className={`mt-1 text-sm font-semibold ${row.changeValue >= 0 ? "text-teal-800" : "text-red-800"}`}>
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
