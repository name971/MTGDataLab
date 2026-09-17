import { notFound } from "next/navigation";
import { getSampleDeckDetail } from "@/lib/sampleDeckDetail";
import { getDeckDetailFromDb } from "@/lib/dbDeckDetail";
import DeckDetailView, { type DeckCardDisplay } from "@/components/DeckDetailView";
import { FORMATS, formatLabel, type Format } from "@/lib/formats";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";
import { fetchExchangeRates } from "@/lib/fx";

function formatLabelSafe(format: string, locale: Locale): string {
  return FORMATS.includes(format as Format) ? formatLabel(format as Format, locale) : format;
}

// 過去のトーナメント戦績デッキは内容が変わらないため、長めにキャッシュしてegressを抑える
export const revalidate = 86400;

/** "2026-07-26" -> "2026/7/26" */
function formatDateShort(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

interface PageDeck {
  title: string;
  subtitle: string;
  cards: DeckCardDisplay[];
  format: string;
}

async function resolveDeck(deckId: string, locale: Locale): Promise<PageDeck | null> {
  const t = getDictionary(locale).deckDetailPage;
  const numericId = Number(deckId);
  if (Number.isInteger(numericId)) {
    const dbDeck = await getDeckDetailFromDb(numericId, locale);
    if (dbDeck) {
      const dateLabel = dbDeck.eventDate ? formatDateShort(dbDeck.eventDate) : null;
      return {
        title: t.deckTitle(dbDeck.playerName),
        subtitle: [formatLabelSafe(dbDeck.format, locale), dbDeck.eventName, dbDeck.standing, dateLabel]
          .filter(Boolean)
          .join(" ・ "),
        cards: dbDeck.cards,
        format: dbDeck.format,
      };
    }
  }

  const sampleDeck = getSampleDeckDetail(deckId);
  if (sampleDeck) {
    return {
      title: locale === "ja" ? sampleDeck.archetypeNameJa : sampleDeck.archetypeNameEn,
      subtitle:
        locale === "ja"
          ? `${sampleDeck.archetypeNameEn} ・ ${sampleDeck.eventName} ・ ${sampleDeck.standing}`
          : `${sampleDeck.eventName} ・ ${sampleDeck.standing}`,
      format: "",
      cards: sampleDeck.cards.map((c) => ({
        oracleId: null,
        nameEn: c.nameEn,
        nameJa: c.nameJa,
        artCropUrl: c.artCropUrl,
        imageNormalUrl: null,
        priceJpy: c.priceJpy,
        typeLine: c.typeLine ?? null,
        manaCost: null,
        quantity: c.quantity,
        board: c.board,
        rarity: null,
      })),
    };
  }

  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; deckId: string }>;
}) {
  const { locale: rawLocale, deckId } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const deck = await resolveDeck(deckId, locale);
  return { title: deck ? `${deck.title} - MTG DataLab` : getDictionary(locale).deckDetailPage.metaTitleFallback };
}

export default async function DeckDetailPage({
  params,
}: {
  params: Promise<{ locale: string; deckId: string }>;
}) {
  const { locale: rawLocale, deckId } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const deck = await resolveDeck(deckId, locale);
  if (!deck) notFound();

  // 英語版は米国市場向けにUSD表示する（2026-09-16方針）
  let usdToJpyRate = 150;
  if (locale === "en") {
    try {
      usdToJpyRate = (await fetchExchangeRates()).usdToJpy;
    } catch {
      // 取得失敗時は既定値150のまま（表示上の概算なので致命的ではない）
    }
  }

  return (
    <DeckDetailView
      cards={deck.cards}
      format={deck.format}
      title={deck.title}
      subtitle={deck.subtitle}
      usdToJpyRate={usdToJpyRate}
    />
  );
}
