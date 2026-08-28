"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/rankings/standard", match: "/rankings", label: "人気カード" },
  { href: "/decks", match: "/decks", label: "デッキ" },
  { href: "/trending", match: "/trending", label: "ランキング" },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-4 text-sm">
      {NAV_ITEMS.map((item) => {
        const active = pathname.startsWith(item.match);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              active
                ? "font-bold text-accent"
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
