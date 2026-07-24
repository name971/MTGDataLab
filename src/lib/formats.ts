export const FORMATS = [
  "Standard",
  "Pioneer",
  "Modern",
  "Legacy",
  "Vintage",
  "Commander",
] as const;

export type Format = (typeof FORMATS)[number];

/** スタンダードのみ集計期間14日、他は30日 */
export function defaultPeriodDays(format: Format): number {
  return format === "Standard" ? 14 : 30;
}

export function formatSlug(format: Format): string {
  return format.toLowerCase();
}
