"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/rankings/standard", match: "/rankings", label: "カードランキング" },
  { href: "/decks", match: "/decks", label: "デッキランキング" },
  { href: "/packs", match: "/packs", label: "パックEV" },
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
                ? "font-medium text-neutral-900"
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
