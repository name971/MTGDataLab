import Link from "next/link";
import { FORMATS, formatSlug } from "@/lib/formats";
import TrendingCard, { type TrendingCardData } from "@/components/TrendingCard";
import { applyDbPrices } from "@/lib/applyDbPrices";
import { getTrendingCardsFromDb } from "@/lib/dbTrendingCards";
import { getTrendingRankingFromDb } from "@/lib/dbTrendingRanking";
import TrendingRankingList from "@/components/TrendingRankingList";

/** trending_scoresがまだ空（3日分蓄積前等）の間だけ使うフォールバック */
const SAMPLE_TRENDING_CARDS: TrendingCardData[] = [
  {
    oracleId: "fable-of-the-mirror-breaker",
    nameJa: "鏡割りの寓話",
    nameEn: "Fable of the Mirror-Breaker",
    artCropUrl:
      "https://cards.scryfall.io/art_crop/front/2/4/24c0d87b-0049-4beb-b9cb-6f813b7aa7dc.jpg",
    category: "price",
    priceJpy: 1840,
    changeLabel: "+12%",
    streakDays: 3,
  },
  {
    oracleId: "this-town-aint-big-enough",
    nameJa: "この町は狭すぎる",
    nameEn: "This Town Ain't Big Enough",
    artCropUrl:
      "https://cards.scryfall.io/art_crop/front/b/b/bb206e27-da4d-4abe-9d8c-6d18c5f2f52a.jpg",
    category: "usage",
    priceJpy: 620,
    changeLabel: "+8pt",
    streakDays: 1,
  },
  {
    oracleId: "force-of-will",
    nameJa: "意志の力",
    nameEn: "Force of Will",
    artCropUrl:
      "https://cards.scryfall.io/art_crop/front/8/9/89f612d6-7c59-4a7b-a87d-45f789e88ba5.jpg",
    category: "price",
    priceJpy: 9120,
    changeLabel: "+3%",
    streakDays: 1,
  },
  {
    oracleId: "solitude",
    nameJa: "孤独",
    nameEn: "Solitude",
    artCropUrl:
      "https://cards.scryfall.io/art_crop/front/4/7/47a6234f-309f-4e03-9263-66da48b57153.jpg",
    category: "usage",
    priceJpy: 5100,
    changeLabel: "+5pt",
    streakDays: 2,
  },
];

export default async function TopPage() {
  const [dbTrendingCards, trendingRanking] = await Promise.all([
    getTrendingCardsFromDb(),
    getTrendingRankingFromDb(),
  ]);
  const trendingCards =
    dbTrendingCards.length > 0 ? dbTrendingCards : await applyDbPrices(SAMPLE_TRENDING_CARDS);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-500">継続注目カード</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {trendingCards.map((card) => (
            <TrendingCard key={card.oracleId} card={card} />
          ))}
        </div>
      </section>

      {trendingRanking.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-neutral-500">注目カードランキング</h2>
          <TrendingRankingList rows={trendingRanking} />
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-500">フォーマットランキング</h2>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map((format) => (
            <Link
              key={format}
              href={`/rankings/${formatSlug(format)}`}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-500"
            >
              {format}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
