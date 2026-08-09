import { MV_BUCKETS, type AdvancedSearchFilters } from "./dbAdvancedSearch";
import { FORMATS, type Format } from "./formats";
import { COLOR_ORDER } from "./manaColors";
import { parseScryfallQuery } from "./scryfallQuerySyntax";

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

/** 配列を重複無しで結合する（フォームの選択とコマンド欄由来の値を合算するため） */
function union<T>(a: T[] | undefined, b: T[] | undefined): T[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

export function parseAdvancedSearchFilters(sp: RawSearchParams): AdvancedSearchFilters {
  const base: AdvancedSearchFilters = {
    name: (Array.isArray(sp.name) ? sp.name[0] : sp.name) || undefined,
    text: (Array.isArray(sp.text) ? sp.text[0] : sp.text) || undefined,
    types: toArray(sp.types).filter((t) => (COMMON_TYPES as readonly string[]).includes(t)),
    typeText: (Array.isArray(sp.type) ? sp.type[0] : sp.type) || undefined,
    colors: toArray(sp.colors).filter((c) => (COLOR_ORDER as readonly string[]).includes(c)),
    colorlessOnly: sp.colorless === "1",
    rarities: toArray(sp.rarity).filter((r) => (RARITIES as readonly string[]).includes(r)),
    formats: toArray(sp.formats).filter((f) => (FORMATS as readonly string[]).includes(f)) as Format[],
    mvBuckets: toArray(sp.mv).filter((v) => (MV_BUCKETS as readonly string[]).includes(v)),
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

  // 検索コマンド欄（Scryfall構文の一部、src/lib/scryfallQuerySyntax.ts）はフォームの他の項目と
  // 併用できる。配列系（タイプ・色・レアリティ・フォーマット・マナ総量）は合算（OR拡張）、
  // 単一値（名前・テキスト・価格帯）はコマンド欄の指定があればそちらを優先する。
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) || undefined;
  if (!q) return base;
  const fromQuery = parseScryfallQuery(q);
  return {
    ...base,
    name: fromQuery.name ?? base.name,
    text: fromQuery.text ?? base.text,
    types: union(base.types, fromQuery.types),
    colors: union(base.colors, fromQuery.colors),
    colorlessOnly: base.colorlessOnly || fromQuery.colorlessOnly,
    rarities: union(base.rarities, fromQuery.rarities),
    formats: union(base.formats, fromQuery.formats),
    mvBuckets: union(base.mvBuckets, fromQuery.mvBuckets),
    priceMin: fromQuery.priceMin ?? base.priceMin,
    priceMax: fromQuery.priceMax ?? base.priceMax,
  };
}
