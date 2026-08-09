import type { AdvancedSearchFilters } from "./dbAdvancedSearch";
import { MV_BUCKETS } from "./dbAdvancedSearch";
import { FORMATS, type Format } from "./formats";
import { COLOR_ORDER } from "./manaColors";

/**
 * Scryfallの検索構文（https://scryfall.com/docs/syntax）のうち、このサイトの既存フィルタで
 * 表現できる範囲だけをサポートするミニパーサー。フル互換ではなく、対応キーワードは
 * t:/type: c:/color: r:/rarity: f:/format: o:/oracle: cmc（比較演算子付き）と、
 * 円建て価格用の独自拡張jpy（Scryfallには無い）のみ。認識できないキーワードは無視し、
 * キーワードに一致しない裸の単語はカード名検索として扱う。
 * 戻り値はAdvancedSearchFiltersの一部で、呼び出し側（parseAdvancedSearchParams.ts）が
 * フォームの他の項目と統合（配列系は合算、単一値は上書き）する。
 */

const COMPARISON_OPS = [">=", "<=", ">", "<", "=", ":"] as const;
type ComparisonOp = (typeof COMPARISON_OPS)[number];

// トークン化: "..."で囲われた語句（前に接頭辞キーが付くこともある。例: o:"draw a card"）は
// 1トークンとして扱い、それ以外は空白区切り
const TOKEN_RE = /[^\s"]*"[^"]*"|\S+/g;

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** "key:value" "key>=value"等を{key, op, value}に分解する。マッチしなければnull（裸の単語扱い） */
function splitKeyOp(token: string): { key: string; op: ComparisonOp; value: string } | null {
  const m = token.match(/^([A-Za-z]+)(>=|<=|>|<|=|:)(.+)$/);
  if (!m) return null;
  const [, key, op, rawValue] = m;
  return { key: key.toLowerCase(), op: op as ComparisonOp, value: stripQuotes(rawValue) };
}

const REP_MV: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7+": 7 };

/** cmc>=3 のような比較条件に合致するマナ総量バケットの一覧を返す（"7+"は代表値7として比較する近似） */
function bucketsForComparison(op: ComparisonOp, n: number): string[] {
  return MV_BUCKETS.filter((b) => {
    const v = REP_MV[b];
    switch (op) {
      case ":":
      case "=":
        return v === n;
      case ">":
        return v > n;
      case ">=":
        return v >= n;
      case "<":
        return v < n;
      case "<=":
        return v <= n;
      default:
        return false;
    }
  });
}

const RARITY_ALIASES: Record<string, string> = {
  c: "common",
  common: "common",
  u: "uncommon",
  uncommon: "uncommon",
  r: "rare",
  rare: "rare",
  m: "mythic",
  mythic: "mythic",
};

export function parseScryfallQuery(query: string): Partial<AdvancedSearchFilters> {
  const result: Partial<AdvancedSearchFilters> = {};
  const types: string[] = [];
  const colors = new Set<string>();
  const rarities = new Set<string>();
  const formats = new Set<Format>();
  let mvBuckets: string[] | undefined;
  const nameWords: string[] = [];

  for (const rawToken of query.match(TOKEN_RE) ?? []) {
    const parsed = splitKeyOp(rawToken);
    if (!parsed) {
      nameWords.push(rawToken);
      continue;
    }
    const { key, op, value } = parsed;

    if (key === "t" || key === "type") {
      types.push(value);
      continue;
    }
    if (key === "c" || key === "color") {
      if (value.toLowerCase() === "c" || value.toLowerCase() === "colorless") {
        result.colorlessOnly = true;
      } else {
        for (const ch of value.toUpperCase()) {
          if ((COLOR_ORDER as readonly string[]).includes(ch)) colors.add(ch);
        }
      }
      continue;
    }
    if (key === "r" || key === "rarity") {
      const rarity = RARITY_ALIASES[value.toLowerCase()];
      if (rarity) rarities.add(rarity);
      continue;
    }
    if (key === "f" || key === "format") {
      const format = FORMATS.find((f) => f.toLowerCase() === value.toLowerCase());
      if (format) formats.add(format);
      continue;
    }
    if (key === "o" || key === "oracle") {
      result.text = value;
      continue;
    }
    if (key === "cmc" || key === "mv") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        const buckets = bucketsForComparison(op, n);
        mvBuckets = [...new Set([...(mvBuckets ?? []), ...buckets])];
      }
      continue;
    }
    if (key === "jpy") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        if (op === ">" || op === ">=") result.priceMin = n;
        else if (op === "<" || op === "<=") result.priceMax = n;
      }
      continue;
    }
    // 未対応のキーワード（pow:/tou:/id:/is:等）は無視する。裸の単語として名前検索に
    // 混ぜてしまうと意図しない絞り込みになるため、認識できたkey:value形式は黙って捨てる。
  }

  if (types.length > 0) result.types = types;
  if (colors.size > 0) result.colors = [...colors];
  if (rarities.size > 0) result.rarities = [...rarities];
  if (formats.size > 0) result.formats = [...formats];
  if (mvBuckets) result.mvBuckets = mvBuckets;
  if (nameWords.length > 0) result.name = nameWords.map(stripQuotes).join(" ");

  return result;
}
