"use client";

import { useEffect } from "react";
import type { Locale } from "@/i18n/config";

// <html lang>はルートレイアウト(app/layout.tsx)にしか置けないため、ロケール配下では
// クライアント側でこの属性だけ上書きする（SSR時は既定のjaのままだがハイドレーション後に
// 即座に正しい値へ揃う。SEO上重要なcanonical/hreflang等は別途metadataで対応する）。
export default function LocaleHtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
