export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";

export function isLocale(v: string | undefined): v is Locale {
  return (LOCALES as readonly string[]).includes(v ?? "");
}
