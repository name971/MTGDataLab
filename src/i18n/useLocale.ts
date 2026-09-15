"use client";

import { useParams } from "next/navigation";
import { isLocale, DEFAULT_LOCALE, type Locale } from "./config";

/** クライアントコンポーネント用。URLの[locale]セグメントを読み、未知の値ならjaにフォールバックする。 */
export function useLocale(): Locale {
  const params = useParams();
  const rawLocale = params.locale as string;
  return isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
}
