import Image from "next/image";
import Link from "next/link";
import { advancedSearchCards, MV_BUCKETS, PAGE_SIZE } from "@/lib/dbAdvancedSearch";
import { RARITY_LABEL_JA } from "@/lib/scryfall";
import { FORMATS } from "@/lib/formats";
import { COLOR_ORDER } from "@/lib/manaColors";
import {
  COMMON_TYPES,
  PERIODS,
  RARITIES,
  parseAdvancedSearchFilters,
  parsePage,
  type RawSearchParams,
} from "@/lib/parseAdvancedSearchParams";

export const metadata = { title: "高度検索 - MTG DataLab" };

/** 現在のsearchParamsを引き継ぎつつ、指定したキーだけ上書きしたクエリ文字列を作る
 * （ソート切り替え・ページ送りのリンク用。値がundefinedのキーは削除する）。 */
function buildHref(sp: RawSearchParams, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key in overrides || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default async function AdvancedSearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseAdvancedSearchFilters(sp);
  const page = parsePage(sp);
  const hasSubmitted = Object.keys(sp).length > 0;
  const { results, totalCount, capped } = hasSubmitted
    ? await advancedSearchCards(filters, (page - 1) * PAGE_SIZE, PAGE_SIZE)
    : { results: [], totalCount: 0, capped: false };
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const selectedColors = new Set(filters.colors);
  const selectedRarities = new Set(filters.rarities);
  const selectedTypes = new Set(filters.types);
  const selectedFormats = new Set(filters.formats);
  const selectedMvBuckets = new Set(filters.mvBuckets);

  // カード詳細ページ「その他のプリント」の並び順ボタンと同じ規則に揃える。
  // 発売日順のデフォルトは新しい順、価格順のデフォルトは安い順（キーを切り替えた直後の向き）
  const SORT_OPTIONS = [
    { key: "price", label: "価格順", defaultDir: "asc" },
    { key: "releasedAt", label: "発売日順", defaultDir: "desc" },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">高度検索</h1>
        <Link href="/search" className="text-sm text-neutral-500 hover:underline">
          通常検索に戻る
        </Link>
      </div>

      {/* 検索コマンド欄（Scryfall構文の一部、src/lib/scryfallQuerySyntax.ts）は一旦UIから外した。
          パース処理自体とparseAdvancedSearchFilters側の合流ロジックは残してあるので、
          将来的にqパラメータで再度使えるようにする時はここにフォームを戻すだけでよい。 */}
      <form className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-4">
        {/* 項目が増えて見通しが悪くなってきたため、意味のまとまりごとにセクション見出し付きで
            区切っている（カード自体の特徴 → フォーマット/レアリティ → 数値レンジ条件、の3段）。 */}
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-xs font-semibold text-neutral-400">カードの特徴</legend>
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
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-t border-neutral-100 pt-4">
          <legend className="mb-1 text-xs font-semibold text-neutral-400">フォーマット・レアリティ</legend>
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-600">
              フォーマット適正（複数選択可、いずれかで合法なカード。採用率は先頭選択分のみ対象）
            </span>
            <div className="flex flex-wrap gap-1.5">
              {FORMATS.map((f) => (
                <label key={f} className="cursor-pointer">
                  <input
                    type="checkbox"
                    name="formats"
                    value={f}
                    defaultChecked={selectedFormats.has(f)}
                    className="peer sr-only"
                  />
                  <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-500 hover:border-neutral-500 peer-checked:border-neutral-500 peer-checked:bg-neutral-100 peer-checked:text-neutral-900">
                    {f}
                  </span>
                </label>
              ))}
            </div>
          </div>

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
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-t border-neutral-100 pt-4">
          <legend className="mb-1 text-xs font-semibold text-neutral-400">数値条件</legend>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-600">マナ総量（複数選択可）</span>
            <div className="flex flex-wrap gap-1.5">
              {MV_BUCKETS.map((mv) => (
                <label key={mv} className="cursor-pointer">
                  <input
                    type="checkbox"
                    name="mv"
                    value={mv}
                    defaultChecked={selectedMvBuckets.has(mv)}
                    className="peer sr-only"
                  />
                  <span className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-300 text-xs text-neutral-500 hover:border-neutral-500 peer-checked:border-neutral-500 peer-checked:bg-neutral-100 peer-checked:font-semibold peer-checked:text-neutral-900">
                    {mv}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-t border-neutral-100 pt-4">
          {/* 価格・値動き・採用率はScryfallには無いこのサイト独自の条件（日次の実勢価格・
              トーナメント採用率データを持っているからこそ出せる指標）なので、あえて区別して見出しを付ける */}
          <legend className="mb-1 text-xs font-semibold text-neutral-400">MTG DataLab独自条件</legend>
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
        </fieldset>

        <button
          type="submit"
          className="self-start rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
        >
          検索
        </button>
      </form>

      {hasSubmitted && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-neutral-500">
              {totalCount}件{capped ? "以上" : ""}ヒット
              {capped && (filters.sortKey ?? "price") === "price" && (
                <span className="ml-1 text-xs text-neutral-400">
                  （該当件数が多いため、価格順の並びは調査した範囲内のみ正確です）
                </span>
              )}
            </p>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-neutral-400">並び順:</span>
              {SORT_OPTIONS.map((opt) => {
                const isActive = (filters.sortKey ?? "price") === opt.key;
                const nextDir = isActive ? (filters.sortDir === "asc" ? "desc" : "asc") : opt.defaultDir;
                return (
                  <Link
                    key={opt.key}
                    href={buildHref(sp, { sortKey: opt.key, sortDir: nextDir, page: undefined })}
                    className={`rounded-md border px-2 py-0.5 ${
                      isActive
                        ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                        : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                    }`}
                  >
                    {opt.label}
                    {isActive && (filters.sortDir === "asc" ? " ▲" : " ▼")}
                  </Link>
                );
              })}
            </div>
          </div>

          {results.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {results.map((card) => (
                <Link
                  key={card.oracleId}
                  href={`/cards/${card.oracleId}`}
                  className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
                >
                  {card.imageUrl && (
                    <Image
                      src={card.imageUrl}
                      alt={card.nameEn}
                      width={223}
                      height={311}
                      className="w-full object-contain"
                    />
                  )}
                  <div className="flex flex-col gap-0.5 p-2">
                    <p className="truncate text-sm font-medium">{card.nameJa ?? card.nameEn}</p>
                    <p className="truncate text-xs text-neutral-500">{card.nameEn}</p>
                    <div className="mt-1 flex items-center justify-between text-xs text-neutral-500">
                      <span>{RARITY_LABEL_JA[card.rarity] ?? card.rarity}</span>
                      <span>
                        {card.priceJpy !== null
                          ? `¥${card.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`
                          : "-"}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-neutral-500">
              条件に一致するカードが見つかりませんでした。
            </p>
          )}

          {totalPages > 1 && (
            // モバイルでも軽く動くよう、読み込み式(もっと見る)ではなくページ単位のリンク遷移にしている
            // （SSRで必要な分だけ取得・都度DBソート済みで返るので、途中まで読み込んだ状態を
            // クライアント側に持ち続ける必要がない）。
            <div className="flex flex-wrap items-center justify-center gap-1 text-sm">
              <Link
                href={buildHref(sp, { page: String(Math.max(1, page - 1)) })}
                aria-disabled={page <= 1}
                className={`rounded-md border px-3 py-1 ${
                  page <= 1
                    ? "pointer-events-none border-neutral-200 text-neutral-300"
                    : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
                }`}
              >
                前へ
              </Link>
              <span className="px-2 text-neutral-500">
                {page} / {totalPages}
              </span>
              <Link
                href={buildHref(sp, { page: String(Math.min(totalPages, page + 1)) })}
                aria-disabled={page >= totalPages}
                className={`rounded-md border px-3 py-1 ${
                  page >= totalPages
                    ? "pointer-events-none border-neutral-200 text-neutral-300"
                    : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
                }`}
              >
                次へ
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
