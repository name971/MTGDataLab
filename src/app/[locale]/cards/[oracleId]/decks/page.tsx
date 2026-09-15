import Link from "next/link";
import { notFound } from "next/navigation";
import { getCardDetailByOracleId, getCardDetailFromDb, type DbCardDetail } from "@/lib/cardData";
import { getDecksByCardAndFormat } from "@/lib/dbDeckDetail";
import { SAMPLE_CARD_SLUGS } from "@/lib/sampleCards";
import { FORMATS, formatLabel, type Format } from "@/lib/formats";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

function formatLabelSafe(format: string, locale: Locale): string {
  return FORMATS.includes(format as Format) ? formatLabel(format as Format, locale) : format;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URLの[oracleId]は「サンプル22枚のスラグ（例: "ragavan"）」と「実データのUUID」の
 * どちらもありうる（src/app/cards/[oracleId]/page.tsxのresolveCardByParamと同じ判定）。
 * ここで前者を無視してUUID決め打ちでDBを引くと、スラグ経由のカードは常に404になっていた
 * （実際に発生していたバグ）。
 */
async function resolveCardDetail(oracleId: string): Promise<DbCardDetail | null> {
  const searchName = SAMPLE_CARD_SLUGS[oracleId];
  if (searchName) return getCardDetailFromDb(searchName);
  if (UUID_PATTERN.test(oracleId)) return getCardDetailByOracleId(oracleId);
  return null;
}

const PERIOD_OPTIONS = [7, 30] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

function resolvePeriod(raw: string | undefined): PeriodDays {
  const n = Number(raw);
  return (PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as PeriodDays) : 7;
}

/** "2026-07-26" -> "2026/7/26" */
function formatDateShort(isoDate: string): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

export default async function CardDecksPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; oracleId: string }>;
  searchParams: Promise<{ format?: string; period?: string }>;
}) {
  const { locale: rawLocale, oracleId } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).cardDecksPage;
  const { format, period } = await searchParams;
  if (!format) notFound();
  const periodDays = resolvePeriod(period);

  const card = await resolveCardDetail(oracleId);
  if (!card) notFound();
  const decks = await getDecksByCardAndFormat(card.oracle.oracle_id, format, periodDays);

  const cardName = locale === "ja" ? (card.oracle.printed_name_ja ?? card.oracle.name) : card.oracle.name;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/${locale}/cards/${oracleId}`} className="text-sm text-neutral-500 hover:underline">
          {t.backTo(cardName)}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{t.heading(cardName, formatLabelSafe(format, locale))}</h1>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-500">{t.periodLabel}</span>
        {PERIOD_OPTIONS.map((p) => (
          <Link
            key={p}
            href={`/${locale}/cards/${oracleId}/decks?format=${encodeURIComponent(format)}&period=${p}`}
            className={`rounded-md border px-2 py-1 text-xs ${
              p === periodDays
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {t.recentDays(p)}
          </Link>
        ))}
      </div>

      {decks.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {decks.map((deck) => (
            <li key={deck.deckId} className="flex items-baseline gap-2">
              <span className="shrink-0 font-numeric tabular-nums text-neutral-400">
                {formatDateShort(deck.eventDate)}
              </span>
              <span className="min-w-0">
                <Link href={`/${locale}/decks/${deck.deckId}`} className="hover:underline">
                  {deck.playerName}
                </Link>
                <span className="text-neutral-500">
                  {" "}
                  （{deck.standing}） ・ {deck.eventName}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">{t.noData}</p>
      )}
    </div>
  );
}
