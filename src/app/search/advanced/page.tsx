import Image from "next/image";
import Link from "next/link";
import { advancedSearchCards, type AdvancedSearchFilters } from "@/lib/dbAdvancedSearch";
import { RARITY_LABEL_JA } from "@/lib/scryfall";
import { FORMATS, type Format } from "@/lib/formats";
import { COLOR_ORDER } from "@/lib/manaColors";

export const metadata = { title: "高度検索 - MTG DataLab" };

const RARITIES = ["common", "uncommon", "rare", "mythic"] as const;

// 他のクリーチャー・タイプ等に比べて検索頻度が高いカード種類は、入力の手間を省くため
// クリック1つで選べるボタンにする（タイプ行の日本語表記、src/lib/typeGlossary.tsと対応）
const COMMON_TYPES = [
  "土地",
  "クリーチャー",
  "エンチャント",
  "アーティファクト",
  "インスタント",
  "ソーサリー",
  "同族",
  "プレインズウォーカー",
  "バトル",
] as const;

type RawSearchParams = Record<string, string | string[] | undefined>;

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseFilters(sp: RawSearchParams): AdvancedSearchFilters {
  const format = Array.isArray(sp.format) ? sp.format[0] : sp.format;
  // タイプ行クイック選択ボタン（typeQuick）が押された場合は、手入力のtype欄より優先する
  // （同じフォーム内の値なので、クイック選択時は手入力欄の内容を上書きする挙動になる）
  const typeQuick = Array.isArray(sp.typeQuick) ? sp.typeQuick[0] : sp.typeQuick;
  const typeManual = (Array.isArray(sp.type) ? sp.type[0] : sp.type) || undefined;
  return {
    name: (Array.isArray(sp.name) ? sp.name[0] : sp.name) || undefined,
    text: (Array.isArray(sp.text) ? sp.text[0] : sp.text) || undefined,
    type: typeQuick || typeManual,
    colors: toArray(sp.colors).filter((c) => (COLOR_ORDER as readonly string[]).includes(c)),
    colorlessOnly: sp.colorless === "1",
    rarities: toArray(sp.rarity).filter((r) => (RARITIES as readonly string[]).includes(r)),
    format: format && (FORMATS as readonly string[]).includes(format) ? (format as Format) : undefined,
    mvMin: toNumber(sp.mvMin),
    mvMax: toNumber(sp.mvMax),
    priceMin: toNumber(sp.priceMin),
    priceMax: toNumber(sp.priceMax),
  };
}

export default async function AdvancedSearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const hasSubmitted = Object.keys(sp).length > 0;
  const results = hasSubmitted ? await advancedSearchCards(filters) : [];

  const selectedColors = new Set(filters.colors);
  const selectedRarities = new Set(filters.rarities);

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
              defaultValue={filters.type ?? ""}
              placeholder="例: 人魚、瞬間魔法"
              className="rounded-md border border-neutral-300 px-2.5 py-1.5"
            />
            <div className="flex flex-wrap gap-1.5">
              {COMMON_TYPES.map((t) => (
                <button
                  key={t}
                  type="submit"
                  name="typeQuick"
                  value={t}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    filters.type === t
                      ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                      : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
                  }`}
                >
                  {t}
                </button>
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

        <div className="flex flex-col gap-1 text-sm sm:w-64">
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

        <button
          type="submit"
          className="self-start rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700"
        >
          検索
        </button>
      </form>

      {hasSubmitted && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-500">{results.length}件ヒット（最大60件まで表示）</p>
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
        </div>
      )}
    </div>
  );
}
