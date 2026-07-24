import { supabase } from "./supabase";

export interface FormatUsageCount {
  format: string;
  deckCount: number;
  /** 前日の同じ幅のウィンドウ（1日ずらし）との比較。前日側が0件で比較不能な場合はnull */
  changePct: number | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** endOffsetDays日前を末日とする、直近periodDays日間の[start, end]を返す */
function periodWindow(periodDays: number, endOffsetDays: number): { start: string; end: string } {
  const end = new Date();
  end.setDate(end.getDate() - endOffsetDays);
  const start = new Date(end);
  start.setDate(start.getDate() - (periodDays - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

interface DeckCardEmbedRow {
  deck_id: number;
  decks: { tournaments: { format: string; event_date: string } | null } | null;
}

/**
 * 指定カード（oracle_id）が、各フォーマットで直近periodDays日間に何個のデッキで使われているかを
 * 集計する。カッコ内の増減率は、1日ずらした同じ幅のウィンドウ（前日を末日とする同じ日数）との
 * 比較（前日比）。deck_cards.oracle_id → decks → tournaments の外部キーをたどって取得するため、
 * このカードを含むデッキが多いフォーマットでも件数は小さく抑えられる（母数はカード単位）。
 */
export async function getFormatUsageCountsForCard(
  oracleId: string,
  periodDays: number = 7,
): Promise<FormatUsageCount[]> {
  const { data, error } = await supabase
    .from("deck_cards")
    .select("deck_id, decks(tournaments(format, event_date))")
    .eq("oracle_id", oracleId)
    .returns<DeckCardEmbedRow[]>();
  if (error || !data) return [];

  // 同じデッキがmain/side両方にこのカードを含むと重複するので、deck_id単位で1件に絞る
  const entryByDeckId = new Map<number, { format: string; eventDate: string }>();
  for (const row of data) {
    const tournament = row.decks?.tournaments;
    if (!tournament) continue;
    if (!entryByDeckId.has(row.deck_id)) {
      entryByDeckId.set(row.deck_id, { format: tournament.format, eventDate: tournament.event_date });
    }
  }
  const entries = [...entryByDeckId.values()];

  const currentWindow = periodWindow(periodDays, 0);
  const prevWindow = periodWindow(periodDays, 1);
  const countInWindow = (format: string, w: { start: string; end: string }) =>
    entries.filter((e) => e.format === format && e.eventDate >= w.start && e.eventDate <= w.end).length;

  const formats = [...new Set(entries.map((e) => e.format))];
  return formats
    .map((format) => {
      const deckCount = countInWindow(format, currentWindow);
      const prevCount = countInWindow(format, prevWindow);
      const changePct = prevCount > 0 ? Math.round(((deckCount - prevCount) / prevCount) * 1000) / 10 : null;
      return { format, deckCount, changePct };
    })
    .filter((f) => f.deckCount > 0)
    .sort((a, b) => b.deckCount - a.deckCount);
}
