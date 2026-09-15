import Link from "next/link";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

export default function Footer({ locale }: { locale?: Locale }) {
  const resolvedLocale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const t = getDictionary(resolvedLocale);
  return (
    <footer className="mt-auto border-t border-neutral-200 px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 text-xs text-neutral-500">
        <nav className="flex flex-wrap gap-x-4 gap-y-2">
          <Link href={`/${resolvedLocale}/rankings/standard`} className="hover:text-neutral-700">
            {t.nav.popularCards}
          </Link>
          <Link href={`/${resolvedLocale}/decks`} className="hover:text-neutral-700">
            {t.nav.decks}
          </Link>
          <Link href={`/${resolvedLocale}/trending`} className="hover:text-neutral-700">
            {t.nav.rankings}
          </Link>
          <Link href={`/${resolvedLocale}/banned-cards`} className="hover:text-neutral-700">
            {t.nav.bannedCards}
          </Link>
        </nav>
        <p>{t.footerLegal}</p>
      </div>
    </footer>
  );
}
