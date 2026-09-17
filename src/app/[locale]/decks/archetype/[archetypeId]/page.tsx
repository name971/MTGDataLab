import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getArchetypeById,
  getDecksByArchetypeId,
  getDeckDetailFromDb,
  type RecentDeckSummary,
} from "@/lib/dbDeckDetail";
import DeckDetailView from "@/components/DeckDetailView";
import { FORMATS, formatLabel, type Format } from "@/lib/formats";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";
import { fetchExchangeRates } from "@/lib/fx";

function formatLabelSafe(format: string, locale: Locale): string {
  return FORMATS.includes(format as Format) ? formatLabel(format as Format, locale) : format;
}

// 集計バッチは1日1回しか回らないため、長めにキャッシュしてegressを抑える
export const revalidate = 21600;

/** "2026-07-26" -> "2026/7/26" */
function formatDateShort(isoDate: string): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

const OTHER_DECKS_VISIBLE_COUNT = 10;

// 代表デッキは「このアーキタイプの今の姿」を見せたいので、古いデッキがいつまでも
// 居座らないよう直近デッキだけを候補にする。7日以内に無ければ30日、それも無ければ90日、
// それでも無ければ全期間、と段階的に候補を広げる。
const REPRESENTATIVE_DECK_WINDOWS_DAYS = [7, 30, 90] as const;

/** "4-0" "2-1-1" 形式のstandingを勝率（勝ち数優先、同点なら負け数が少ない方）で比較する */
function winRateRank(standing: string): { wins: number; losses: number } {
  const [wins, losses] = standing.split("-").map((n) => parseInt(n, 10) || 0);
  return { wins, losses };
}

function pickCandidates(decks: RecentDeckSummary[]): RecentDeckSummary[] {
  for (const windowDays of REPRESENTATIVE_DECK_WINDOWS_DAYS) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const inWindow = decks.filter((d) => d.eventDate >= cutoffStr);
    if (inWindow.length > 0) return inWindow;
  }
  return decks;
}

function pickBestDeck(decks: RecentDeckSummary[]): RecentDeckSummary | null {
  if (decks.length === 0) return null;

  const candidates = pickCandidates(decks);

  return [...candidates].sort((a, b) => {
    const rankA = winRateRank(a.standing);
    const rankB = winRateRank(b.standing);
    if (rankB.wins !== rankA.wins) return rankB.wins - rankA.wins;
    if (rankA.losses !== rankB.losses) return rankA.losses - rankB.losses;
    // 戦績が完全に同点なら、新しい開催日の方を優先する
    return a.eventDate < b.eventDate ? 1 : -1;
  })[0];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; archetypeId: string }>;
}) {
  const { locale: rawLocale, archetypeId } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).archetypeDetail;
  const archetype = await getArchetypeById(Number(archetypeId));
  if (!archetype) return { title: t.metaTitleFallback };
  const name = locale === "ja" ? (archetype.nameJa ?? archetype.nameEn) : archetype.nameEn;
  return { title: `${name} - MTG DataLab` };
}

export default async function ArchetypeDetailPage({
  params,
}: {
  params: Promise<{ locale: string; archetypeId: string }>;
}) {
  const { locale: rawLocale, archetypeId } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).archetypeDetail;
  const numericId = Number(archetypeId);
  if (!Number.isInteger(numericId)) notFound();

  const archetype = await getArchetypeById(numericId);
  if (!archetype) notFound();

  const decks = await getDecksByArchetypeId(numericId);
  const bestDeck = pickBestDeck(decks);
  const bestDeckDetail = bestDeck ? await getDeckDetailFromDb(bestDeck.deckId, locale) : null;
  // 新しい開催日順（開催日が同じ場合はdeckId降順）に並べてから表示する
  const otherDecks = decks
    .filter((d) => d.deckId !== bestDeck?.deckId)
    .sort((a, b) => (a.eventDate === b.eventDate ? b.deckId - a.deckId : a.eventDate < b.eventDate ? 1 : -1));
  const visibleOtherDecks = otherDecks.slice(0, OTHER_DECKS_VISIBLE_COUNT);
  const collapsedOtherDecks = otherDecks.slice(OTHER_DECKS_VISIBLE_COUNT);

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
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">
          {locale === "ja" ? (archetype.nameJa ?? archetype.nameEn) : archetype.nameEn}
        </h1>
        <p className="text-sm text-neutral-500">
          {archetype.nameEn} ・ {formatLabelSafe(archetype.format, locale)}
        </p>
      </div>

      <Link
        href={`/${locale}/decks?format=${archetype.format.toLowerCase()}`}
        className="text-sm text-neutral-500 hover:underline"
      >
        {t.backToRanking}
      </Link>

      {bestDeck && bestDeckDetail ? (
        <DeckDetailView
          cards={bestDeckDetail.cards}
          format={bestDeckDetail.format}
          usdToJpyRate={usdToJpyRate}
          headerContent={
            <p className="text-sm text-neutral-500">
              {t.representativeDeck}{" "}
              <Link href={`/${locale}/decks/${bestDeck.deckId}`} className="hover:underline">
                {bestDeckDetail.playerName}
              </Link>{" "}
              （{bestDeckDetail.standing}） ・ {bestDeckDetail.eventName}
            </p>
          }
        />
      ) : (
        <p className="text-sm text-neutral-500">{t.noDecks}</p>
      )}

      {otherDecks.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-500">{t.otherDecks}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {visibleOtherDecks.map((deck) => (
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
                    ({deck.standing}) ・ {deck.eventName}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {collapsedOtherDecks.length > 0 && (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-neutral-500 hover:underline">
                {t.showRemaining(collapsedOtherDecks.length)}
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {collapsedOtherDecks.map((deck) => (
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
                        ({deck.standing}) ・ {deck.eventName}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
