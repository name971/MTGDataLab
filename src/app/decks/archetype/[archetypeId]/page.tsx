import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getArchetypeById,
  getDecksByArchetypeId,
  getDeckDetailFromDb,
  type RecentDeckSummary,
} from "@/lib/dbDeckDetail";
import DeckDetailView from "@/components/DeckDetailView";
import { totalPriceJpy } from "@/lib/deckPricing";

/** "4-0" "2-1-1" 形式のstandingを勝率（勝ち数優先、同点なら負け数が少ない方）で比較する */
function winRateRank(standing: string): { wins: number; losses: number } {
  const [wins, losses] = standing.split("-").map((n) => parseInt(n, 10) || 0);
  return { wins, losses };
}

function pickBestDeck(decks: RecentDeckSummary[]): RecentDeckSummary | null {
  if (decks.length === 0) return null;
  return [...decks].sort((a, b) => {
    const rankA = winRateRank(a.standing);
    const rankB = winRateRank(b.standing);
    if (rankB.wins !== rankA.wins) return rankB.wins - rankA.wins;
    return rankA.losses - rankB.losses;
  })[0];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ archetypeId: string }>;
}) {
  const { archetypeId } = await params;
  const archetype = await getArchetypeById(Number(archetypeId));
  if (!archetype) return { title: "MTG DataLab" };
  return { title: `${archetype.nameJa ?? archetype.nameEn} - MTG DataLab` };
}

export default async function ArchetypeDetailPage({
  params,
}: {
  params: Promise<{ archetypeId: string }>;
}) {
  const { archetypeId } = await params;
  const numericId = Number(archetypeId);
  if (!Number.isInteger(numericId)) notFound();

  const archetype = await getArchetypeById(numericId);
  if (!archetype) notFound();

  const decks = await getDecksByArchetypeId(numericId);
  const bestDeck = pickBestDeck(decks);
  const bestDeckDetail = bestDeck ? await getDeckDetailFromDb(bestDeck.deckId) : null;
  const otherDecks = decks.filter((d) => d.deckId !== bestDeck?.deckId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{archetype.nameJa ?? archetype.nameEn}</h1>
        <p className="text-sm text-neutral-500">
          {archetype.nameEn} ・ {archetype.format}
        </p>
      </div>

      <Link
        href={`/decks?format=${archetype.format.toLowerCase()}`}
        className="text-sm text-neutral-500 hover:underline"
      >
        ← デッキランキングに戻る
      </Link>

      {bestDeck && bestDeckDetail ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm text-neutral-500">
              代表デッキ（最多勝率）:{" "}
              <Link href={`/decks/${bestDeck.deckId}`} className="hover:underline">
                {bestDeckDetail.playerName}
              </Link>{" "}
              （{bestDeckDetail.standing}） ・ {bestDeckDetail.eventName}
            </p>
            <p className="whitespace-nowrap text-sm font-semibold">
              ¥{totalPriceJpy(bestDeckDetail.cards).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
            </p>
          </div>
          <DeckDetailView cards={bestDeckDetail.cards} format={bestDeckDetail.format} />
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          このアーキタイプに分類されたデッキは登録されていません。
        </p>
      )}

      {otherDecks.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">他のデッキ</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {otherDecks.map((deck) => (
              <li key={deck.deckId}>
                <Link href={`/decks/${deck.deckId}`} className="hover:underline">
                  {deck.playerName}
                </Link>
                <span className="text-neutral-500">
                  {" "}
                  ({deck.standing}) ・ {deck.eventName}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
