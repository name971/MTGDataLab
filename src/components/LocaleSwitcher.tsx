"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LOCALES, type Locale } from "@/i18n/config";
import { useLocale } from "@/i18n/useLocale";

/** 現在のパス・クエリを保ったまま、先頭のロケールセグメントだけ差し替える */
function hrefForLocale(pathname: string, queryString: string, target: Locale): string {
  const rest = pathname.replace(/^\/(ja|en)(?=\/|$)/, "") || "/";
  const qs = queryString ? `?${queryString}` : "";
  return `/${target}${rest}${qs}`;
}

export default function LocaleSwitcher() {
  return (
    <Suspense fallback={null}>
      <LocaleSwitcherInner />
    </Suspense>
  );
}

function LocaleSwitcherInner() {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();

  return (
    <div className="flex shrink-0 items-center gap-0.5 text-xs font-medium">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={hrefForLocale(pathname, queryString, l)}
          className={`rounded px-1.5 py-0.5 uppercase ${
            l === locale ? "bg-neutral-800 text-white" : "text-neutral-400 hover:text-neutral-700"
          }`}
        >
          {l}
        </Link>
      ))}
    </div>
  );
}
