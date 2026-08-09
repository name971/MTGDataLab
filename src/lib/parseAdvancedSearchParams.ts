import type { AdvancedSearchFilters } from "./dbAdvancedSearch";
import { FORMATS, type Format } from "./formats";
import { COLOR_ORDER } from "./manaColors";

export const RARITIES = ["common", "uncommon", "rare", "mythic"] as const;
export const PERIODS = [7, 30, 90] as const;

// 他のクリーチャー・タイプ等に比べて検索頻度が高いカード種類は、入力の手間を省くため
// クリック1つで選べるボタンにする（タイプ行の日本語表記、src/lib/typeGlossary.tsと対応）
export const COMMON_TYPES = [
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

export type RawSearchParams = Record<string, string | string[] | undefined>;

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

function toPeriod(value: string | string[] | undefined): 7 | 30 | 90 | undefined {
  const n = toNumber(value);
  return (PERIODS as readonly number[]).includes(n as number) ? (n as 7 | 30 | 90) : undefined;
}

/** ページ側のフォームsearchParamsと、もっと見るAPI（/api/advanced-search）のクエリパラメータ
 * どちらからも同じ規則でフィルタを組み立てられるよう共通化したもの。 */
export function parseAdvancedSearchFilters(sp: RawSearchParams): AdvancedSearchFilters {
  const format = Array.isArray(sp.format) ? sp.format[0] : sp.format;
  return {
    name: (Array.isArray(sp.name) ? sp.name[0] : sp.name) || undefined,
    text: (Array.isArray(sp.text) ? sp.text[0] : sp.text) || undefined,
    types: toArray(sp.types).filter((t) => (COMMON_TYPES as readonly string[]).includes(t)),
    typeText: (Array.isArray(sp.type) ? sp.type[0] : sp.type) || undefined,
    colors: toArray(sp.colors).filter((c) => (COLOR_ORDER as readonly string[]).includes(c)),
    colorlessOnly: sp.colorless === "1",
    rarities: toArray(sp.rarity).filter((r) => (RARITIES as readonly string[]).includes(r)),
    format: format && (FORMATS as readonly string[]).includes(format) ? (format as Format) : undefined,
    mvMin: toNumber(sp.mvMin),
    mvMax: toNumber(sp.mvMax),
    priceMin: toNumber(sp.priceMin),
    priceMax: toNumber(sp.priceMax),
    usageRateMin: toNumber(sp.usageRateMin),
    usageRateMax: toNumber(sp.usageRateMax),
    usagePeriodDays: toPeriod(sp.usagePeriodDays) ?? 30,
    priceChangeMin: toNumber(sp.priceChangeMin),
    priceChangeMax: toNumber(sp.priceChangeMax),
    priceChangePeriodDays: toPeriod(sp.priceChangePeriodDays) ?? 7,
  };
}
