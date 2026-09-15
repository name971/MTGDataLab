"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/i18n/useLocale";
import { getDictionary } from "@/i18n/getDictionary";

export default function NavLinks() {
  const pathname = usePathname();
  const locale = useLocale();
  const t = getDictionary(locale);

  const NAV_ITEMS = [
    { href: "/rankings/standard", match: "/rankings", label: t.nav.popularCards },
    { href: "/decks", match: "/decks", label: t.nav.decks },
    { href: "/trending", match: "/trending", label: t.nav.rankings },
  ];

  return (
    <nav className="flex gap-4 text-sm">
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(`/${locale}${item.match}`);
        return (
          <Link
            key={item.href}
            href={`/${locale}${item.href}`}
            className={
              active
                ? "font-bold text-accent-text"
                : "text-neutral-600 hover:text-neutral-900"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
