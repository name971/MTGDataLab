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

function toSortKey(value: string | string[] | undefined): "price" | "releasedAt" {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "releasedAt" ? "releasedAt" : "price";
}

function toSortDir(value: string | string[] | undefined): "asc" | "desc" {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" ? "asc" : "desc";
}

/** ページ番号（1始まり）。不正・未指定時は1ページ目扱い */
export function parsePage(sp: RawSearchParams): number {
  const raw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function parseAdvancedSearchFilters(sp: RawSearchParams): AdvancedSearchFilters {
  return {
    name: (Array.isArray(sp.name) ? sp.name[0] : sp.name) || undefined,
    text: (Array.isArray(sp.text) ? sp.text[0] : sp.text) || undefined,
    types: toArray(sp.types).filter((t) => (COMMON_TYPES as readonly string[]).includes(t)),
    typeText: (Array.isArray(sp.type) ? sp.type[0] : sp.type) || undefined,
    colors: toArray(sp.colors).filter((c) => (COLOR_ORDER as readonly string[]).includes(c)),
    colorlessOnly: sp.colorless === "1",
    rarities: toArray(sp.rarity).filter((r) => (RARITIES as readonly string[]).includes(r)),
    formats: toArray(sp.formats).filter((f) => (FORMATS as readonly string[]).includes(f)) as Format[],
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
    sortKey: toSortKey(sp.sortKey),
    sortDir: toSortDir(sp.sortDir),
  };
}
