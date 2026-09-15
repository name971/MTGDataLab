export const FORMATS = [
  "Standard",
  "Pioneer",
  "Modern",
  "Legacy",
  "Vintage",
  "Commander",
] as const;

export type Format = (typeof FORMATS)[number];

const FORMAT_LABELS_JA: Record<Format, string> = {
  Standard: "スタンダード",
  Pioneer: "パイオニア",
  Modern: "モダン",
  Legacy: "レガシー",
  Vintage: "ヴィンテージ",
  Commander: "コマンダー",
};

export function formatLabelJa(format: Format): string {
  return FORMAT_LABELS_JA[format];
}

/** 英語版は元々のFormat文字列（"Standard"等）がそのまま英語名として使える */
export function formatLabel(format: Format, locale: "ja" | "en"): string {
  return locale === "ja" ? FORMAT_LABELS_JA[format] : format;
}

/** スタンダードのみ集計期間14日、他は30日 */
export function defaultPeriodDays(format: Format): number {
  return format === "Standard" ? 14 : 30;
}

export function formatSlug(format: Format): string {
  return format.toLowerCase();
}
