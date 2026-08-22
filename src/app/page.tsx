import { Suspense } from "react";
import TrendingCard, { type TrendingCardData } from "@/components/TrendingCard";
import { applyDbPrices } from "@/lib/applyDbPrices";
import { getTrendingCardsFromDb } from "@/lib/dbTrendingCards";
import { getMlRankingFromDb } from "@/lib/dbMlRanking";
import MlRankingList from "@/components/MlRankingList";
import InfoTooltip from "@/components/InfoTooltip";
import MaintenanceBanner from "@/components/MaintenanceBanner";

// 集計バッチは1日1回しか回らないため、鮮度より egress 削減を優先して長めにキャッシュする（ISR）
export const revalidate = 3600;

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
    asOfDate: "2026-01-01",
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
    asOfDate: "2026-01-01",
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
    asOfDate: "2026-01-01",
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
    asOfDate: "2026-01-01",
  },
];

export default async function TopPage() {
  // DB接続そのものが失敗した場合（データがまだ無いだけの場合と区別、dbTrendingCards.ts参照）は
  // サンプルデータへ黙ってフォールバックせず、メンテナンス中であることを表示する
  // （2026-08-17、DB障害中もサイトが正常に見えてしまっていたインシデントの再発防止）。
  let dbTrendingCards: TrendingCardData[] = [];
  let mlRankingUp: Awaited<ReturnType<typeof getMlRankingFromDb>> = [];
  let mlRankingDown: Awaited<ReturnType<typeof getMlRankingFromDb>> = [];
  let dbDown = false;
  try {
    [dbTrendingCards, mlRankingUp, mlRankingDown] = await Promise.all([
      getTrendingCardsFromDb(),
      getMlRankingFromDb("up"),
      getMlRankingFromDb("down"),
    ]);
  } catch {
    dbDown = true;
  }
  // dbDown中はサンプルへのフォールバックもしない（本物のデータのように見えてしまうため）。
  // フォールバックが必要なのは「DBは生きているがまだデータが溜まっていない」ケースのみ。
  const trendingCards = dbDown
    ? []
    : dbTrendingCards.length > 0
      ? dbTrendingCards
      : await applyDbPrices(SAMPLE_TRENDING_CARDS);

  return (
    <div className="flex flex-col gap-10">
      {dbDown && <MaintenanceBanner />}

      {trendingCards.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-neutral-500">継続注目カード</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {trendingCards.map((card) => (
              <TrendingCard key={card.oracleId} card={card} />
            ))}
          </div>
        </section>
      )}

      {(mlRankingUp.length > 0 || mlRankingDown.length > 0) && (
        <section>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-neutral-500">
            注目カードランキング
            <InfoTooltip text="7日以内に一定以上値上がり・値下がりする確率を機械学習モデルで予測し、確率が高い順に並べています（トーナメントで使用実績のあるカードが対象）。過去のTop10的中率: 高騰予想は約73%、暴落予想は約95%。" />
          </h2>
          <Suspense fallback={null}>
            <MlRankingList up={mlRankingUp} down={mlRankingDown} />
          </Suspense>
        </section>
      )}

    </div>
  );
}
