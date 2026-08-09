import Image from "next/image";
import Link from "next/link";
import { advancedSearchCards } from "@/lib/dbAdvancedSearch";
import { RARITY_LABEL_JA } from "@/lib/scryfall";
import { FORMATS } from "@/lib/formats";
import { COLOR_ORDER } from "@/lib/manaColors";
import { COMMON_TYPES, PERIODS, RARITIES, parseAdvancedSearchFilters, type RawSearchParams } from "@/lib/parseAdvancedSearchParams";
import AdvancedSearchResults from "@/components/AdvancedSearchResults";

export const metadata = { title: "高度検索 - MTG DataLab" };

export default async function AdvancedSearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseAdvancedSearchFilters(sp);
  const hasSubmitted = Object.keys(sp).length > 0;
  const { results, totalCount } = hasSubmitted
    ? await advancedSearchCards(filters)
    : { results: [], totalCount: 0 };

  // 「もっと見る」で/api/advanced-searchに渡す時も同じ条件になるよう、フォームの実際の
  // searchParams（配列パラメータも含む）からそのままクエリ文字列を組み立てる
  const queryString = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x]))),
  ).toString();

  const selectedColors = new Set(filters.colors);
  const selectedRarities = new Set(filters.rarities);
  const selectedTypes = new Set(filters.types);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">高度検索</h1>
        <Link href="/search" className="text-sm text-neutral-500 hover:underline">
          通常検索に戻る
        </Link>
      </div>

      <form className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">カード名</span>
            <input
              type="text"
              name="name"
              defaultValue={filters.name ?? ""}
              placeholder="例: 稲妻"
              className="rounded-md border border-neutral-300 px-2.5 py-1.5"
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">タイプ行</span>
            <input
              type="text"
              name="type"
              defaultValue={filters.typeText ?? ""}
              placeholder="例: 人魚、瞬間魔法"
              className="rounded-md border border-neutral-300 px-2.5 py-1.5"
            />
            {/* チェックボックスをボタン風に見せるだけの選択トグル（送信ボタンではない）。
                複数同時にONにでき、フォーム送信時に全て"types"としてまとめて送られる
                （AND絞り込み。例: クリーチャー+エンチャントでエンチャント・クリーチャーに絞れる）。
                以前はtype="submit"のボタンで、押すたびに単独の値で即送信していたため
                2つ以上同時に選べなかった。 */}
            <div className="flex flex-wrap gap-1.5">
              {COMMON_TYPES.map((t) => (
                <label key={t} className="cursor-pointer">
                  <input
                    type="checkbox"
                    name="types"
                    value={t}
                    defaultChecked={selectedTypes.has(t)}
                    className="peer sr-only"
                  />
                  <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-500 hover:border-neutral-500 peer-checked:border-neutral-500 peer-checked:bg-neutral-100 peer-checked:text-neutral-900">
                    {t}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">ルールテキスト（英語のオラクルテキストに含む語句）</span>
          <input
            type="text"
            name="text"
            defaultValue={filters.text ?? ""}
            placeholder="例: draw a card"
            className="rounded-md border border-neutral-300 px-2.5 py-1.5"
          />
        </label>

        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-neutral-600">色（選択した色を全て含むカード）</span>
          <div className="flex flex-wrap items-center gap-3">
            {COLOR_ORDER.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input type="checkbox" name="colors" value={c} defaultChecked={selectedColors.has(c)} />
                <Image src={`/mana/${c}.svg`} alt={c} width={20} height={20} />
              </label>
            ))}
            <label className="ml-2 flex items-center gap-1.5 border-l border-neutral-200 pl-3">
              <input type="checkbox" name="colorless" value="1" defaultChecked={filters.colorlessOnly} />
              無色のみ
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-600">レアリティ</span>
            <div className="flex flex-wrap gap-3">
              {RARITIES.map((r) => (
                <label key={r} className="flex items-center gap-1.5">
                  <input type="checkbox" name="rarity" value={r} defaultChecked={selectedRarities.has(r)} />
                  {RARITY_LABEL_JA[r]}
                </label>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">フォーマット適正</span>
            <select
              name="format"
              defaultValue={filters.format ?? ""}
              className="rounded-md border border-neutral-300 px-2.5 py-1.5"
            >
              <option value="">指定なし</option>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">マナ総量</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                name="mvMin"
                min={0}
                defaultValue={filters.mvMin ?? ""}
                placeholder="下限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <span className="text-neutral-400">〜</span>
              <input
                type="number"
                name="mvMax"
                min={0}
                defaultValue={filters.mvMax ?? ""}
                placeholder="上限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">価格帯（円）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                name="priceMin"
                min={0}
                defaultValue={filters.priceMin ?? ""}
                placeholder="下限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <span className="text-neutral-400">〜</span>
              <input
                type="number"
                name="priceMax"
                min={0}
                defaultValue={filters.priceMax ?? ""}
                placeholder="上限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">
              価格変化率（%、指定期間前との比較。マイナス指定で値下がりも絞れる）
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                name="priceChangeMin"
                defaultValue={filters.priceChangeMin ?? ""}
                placeholder="下限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <span className="text-neutral-400">〜</span>
              <input
                type="number"
                name="priceChangeMax"
                defaultValue={filters.priceChangeMax ?? ""}
                placeholder="上限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <select
                name="priceChangePeriodDays"
                defaultValue={filters.priceChangePeriodDays ?? 7}
                className="shrink-0 rounded-md border border-neutral-300 px-2 py-1.5 text-xs"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}日前比
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">採用率（%、「フォーマット適正」の指定が必要）</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                name="usageRateMin"
                min={0}
                max={100}
                defaultValue={filters.usageRateMin ?? ""}
                placeholder="下限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <span className="text-neutral-400">〜</span>
              <input
                type="number"
                name="usageRateMax"
                min={0}
                max={100}
                defaultValue={filters.usageRateMax ?? ""}
                placeholder="上限"
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5"
              />
              <select
                name="usagePeriodDays"
                defaultValue={filters.usagePeriodDays ?? 30}
                className="shrink-0 rounded-md border border-neutral-300 px-2 py-1.5 text-xs"
              >
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    直近{p}日
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <button
          type="submit"
          className="self-start rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
        >
          検索
        </button>
      </form>

      {hasSubmitted && (
        <AdvancedSearchResults initialResults={results} totalCount={totalCount} queryString={queryString} />
      )}
    </div>
  );
}
