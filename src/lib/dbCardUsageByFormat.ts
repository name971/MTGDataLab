import { supabase } from "./supabase";

export interface FormatUsageCount {
  format: string;
  deckCount7d: number;
  /** 前日の同じ7日ウィンドウ（1日ずらし）との比較。前日側が0件で比較不能な場合はnull */
  changePct: number | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** endOffsetDays日前を末日とする、直近7日間（7日間ぶん、当日含む）の[start, end]を返す */
function sevenDayWindow(endOffsetDays: number): { start: string; end: string } {
  const end = new Date();
  end.setDate(end.getDate() - endOffsetDays);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start: isoDate(start), end: isoDate(end) };
}

interface DeckCardEmbedRow {
  deck_id: number;
  decks: { tournaments: { format: string; event_date: string } | null } | null;
}

/**
 * 指定カード（oracle_id）が、各フォーマットで直近7日間に何個のデッキで使われているかを集計する。
 * カッコ内の増減率は、1日ずらした同じ7日ウィンドウ（前日を末日とする直近7日間）との比較（前日比）。
 * deck_cards.oracle_id → decks → tournaments の外部キーをたどって取得するため、
 * このカードを含むデッキが多いフォーマットでも件数は小さく抑えられる（母数はカード単位）。
 */
export async function getFormatUsageCountsForCard(oracleId: string): Promise<FormatUsageCount[]> {
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

  const todayWindow = sevenDayWindow(0);
  const yesterdayWindow = sevenDayWindow(1);
  const countInWindow = (format: string, w: { start: string; end: string }) =>
    entries.filter((e) => e.format === format && e.eventDate >= w.start && e.eventDate <= w.end).length;

  const formats = [...new Set(entries.map((e) => e.format))];
  return formats
    .map((format) => {
      const deckCount7d = countInWindow(format, todayWindow);
      const prevCount = countInWindow(format, yesterdayWindow);
      const changePct = prevCount > 0 ? Math.round(((deckCount7d - prevCount) / prevCount) * 1000) / 10 : null;
      return { format, deckCount7d, changePct };
    })
    .filter((f) => f.deckCount7d > 0)
    .sort((a, b) => b.deckCount7d - a.deckCount7d);
}
