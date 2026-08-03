import { notFound } from "next/navigation";
import { getSampleDeckDetail } from "@/lib/sampleDeckDetail";
import { getDeckDetailFromDb } from "@/lib/dbDeckDetail";
import DeckDetailView, { type DeckCardDisplay } from "@/components/DeckDetailView";

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

async function resolveDeck(deckId: string): Promise<PageDeck | null> {
  const numericId = Number(deckId);
  if (Number.isInteger(numericId)) {
    const dbDeck = await getDeckDetailFromDb(numericId);
    if (dbDeck) {
      const dateLabel = dbDeck.eventDate ? formatDateShort(dbDeck.eventDate) : null;
      return {
        title: `${dbDeck.playerName} のデッキ`,
        subtitle: [dbDeck.format, dbDeck.eventName, dbDeck.standing, dateLabel]
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
      title: sampleDeck.archetypeNameJa,
      subtitle: `${sampleDeck.archetypeNameEn} ・ ${sampleDeck.eventName} ・ ${sampleDeck.standing}`,
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
  params: Promise<{ deckId: string }>;
}) {
  const { deckId } = await params;
  const deck = await resolveDeck(deckId);
  return { title: deck ? `${deck.title} - MTG DataLab` : "MTG DataLab" };
}

export default async function DeckDetailPage({
  params,
}: {
  params: Promise<{ deckId: string }>;
}) {
  const { deckId } = await params;
  const deck = await resolveDeck(deckId);
  if (!deck) notFound();

  return <DeckDetailView cards={deck.cards} format={deck.format} title={deck.title} subtitle={deck.subtitle} />;
}
