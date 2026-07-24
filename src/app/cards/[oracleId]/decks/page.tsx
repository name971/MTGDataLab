import Link from "next/link";
import { notFound } from "next/navigation";
import { getCardDetailByOracleId } from "@/lib/cardData";
import { getDecksByCardAndFormat } from "@/lib/dbDeckDetail";

const PERIOD_OPTIONS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIOD_OPTIONS)[number];

function resolvePeriod(raw: string | undefined): PeriodDays {
  const n = Number(raw);
  return (PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as PeriodDays) : 7;
}

export default async function CardDecksPage({
  params,
  searchParams,
}: {
  params: Promise<{ oracleId: string }>;
  searchParams: Promise<{ format?: string; period?: string }>;
}) {
  const { oracleId } = await params;
  const { format, period } = await searchParams;
  if (!format) notFound();
  const periodDays = resolvePeriod(period);

  const [card, decks] = await Promise.all([
    getCardDetailByOracleId(oracleId),
    getDecksByCardAndFormat(oracleId, format, periodDays),
  ]);
  if (!card) notFound();

  const cardName = card.oracle.printed_name_ja ?? card.oracle.name;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/cards/${oracleId}`} className="text-sm text-neutral-500 hover:underline">
          ← {cardName}に戻る
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {cardName}を使用したデッキ（{format}）
        </h1>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-500">集計期間:</span>
        {PERIOD_OPTIONS.map((p) => (
          <Link
            key={p}
            href={`/cards/${oracleId}/decks?format=${encodeURIComponent(format)}&period=${p}`}
            className={`rounded-md border px-2 py-1 text-xs ${
              p === periodDays
                ? "border-neutral-500 bg-neutral-100 text-neutral-900"
                : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
            }`}
          >
            直近{p}日
          </Link>
        ))}
      </div>

      {decks.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {decks.map((deck) => (
            <li key={deck.deckId}>
              <Link href={`/decks/${deck.deckId}`} className="hover:underline">
                {deck.playerName}
              </Link>
              <span className="text-neutral-500">
                {" "}
                （{deck.standing}） ・ {deck.eventName}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500">この期間に該当するデッキはありません。</p>
      )}
    </div>
  );
}
