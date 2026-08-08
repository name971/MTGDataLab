import { supabase } from "./supabase";
import { FORMATS } from "./formats";

export interface FormatUsageCount {
  format: string;
  deckCount: number;
  /**
   * 採用率（%、そのフォーマットの全デッキ数に対するこのカードの採用デッキ数の割合）の、
   * 直前の同じ日数分のウィンドウ（非重複）との相対変化率（%）。トーナメント開催数が週によって
   * 増減するとdeckCount自体はそれに引きずられて増減するが、採用率はその影響を受けにくいため
   * こちらを増減の指標にする（件数の増減率だと、母数の変動だけでカードの人気が変わったように
   * 誤解されることがあった）。前期間側の母数か採用率が0で比較不能な場合はnull。
   */
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
 * 集計する。カッコ内の増減率は、直前の同じ日数分・非重複のウィンドウとの比較（前期間比）。
 * 例: 7日間なら直前7日間、30日間なら直前30日間、90日間なら直前90日間と比較する。
 * deck_cards.oracle_id → decks → tournaments の外部キーをたどって取得するため、
 * このカードを含むデッキが多いフォーマットでも件数は小さく抑えられる（母数はカード単位）。
 */
export async function getFormatUsageCountsForCard(
  oracleId: string,
  periodDays: number = 7,
): Promise<FormatUsageCount[]> {
  // 絞り込み無しで全期間を取得すると、採用数の多いカード（例: 全期間で1000件超のデッキに
  // 入っているカード）でSupabase/PostgRESTのデフォルト上限（1000行）に達し、直近分（＝この
  // 集計に必要な分）が並び順によっては黙って切り捨てられる。今回必要な範囲
  // （前期間の開始日〜今期間の終了日）だけをサーバー側で絞り込んでから取得する。
  //
  // ただし日付で絞り込んでもなお1000件を超えることがある（実際に発生: Chrome Moxは
  // Commanderだけで直近14日に1000件超採用されており、同じ期間のLegacy分がその陰に
  // 隠れて丸ごと切り捨てられていた＝Legacyの使用デッキが0件と誤表示される原因だった）。
  // 日付フィルタだけでは不十分なため、Rangeでページングして全件取得する。
  const currentWindow = periodWindow(periodDays, 0);
  const prevWindow = periodWindow(periodDays, periodDays);

  const PAGE_SIZE = 1000;
  const data: DeckCardEmbedRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("deck_cards")
      .select("deck_id, decks!inner(tournaments!inner(format, event_date))")
      .eq("oracle_id", oracleId)
      .gte("decks.tournaments.event_date", prevWindow.start)
      .lte("decks.tournaments.event_date", currentWindow.end)
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<DeckCardEmbedRow[]>();
    if (error) return [];
    if (!page || page.length === 0) break;
    data.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

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

  const countInWindow = (format: string, w: { start: string; end: string }) =>
    entries.filter((e) => e.format === format && e.eventDate >= w.start && e.eventDate <= w.end).length;

  const formats = [...new Set(entries.map((e) => e.format))];
  if (formats.length === 0) return [];

  // 採用率(%)の分母（そのフォーマットの全デッキ数）を、このカードを含むかどうかに関わらず
  // 取得する。Commanderだけで直近7日に1000件を超えることが実際にあるため、こちらもページングする。
  const totalDecks: { format: string; event_date: string }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("decks")
      .select("tournaments!inner(format, event_date)")
      .in("tournaments.format", formats)
      .gte("tournaments.event_date", prevWindow.start)
      .lte("tournaments.event_date", currentWindow.end)
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<{ tournaments: { format: string; event_date: string } }[]>();
    if (error) break;
    if (!page || page.length === 0) break;
    for (const row of page) totalDecks.push(row.tournaments);
    if (page.length < PAGE_SIZE) break;
  }

  const totalCountInWindow = (format: string, w: { start: string; end: string }) =>
    totalDecks.filter((d) => d.format === format && d.event_date >= w.start && d.event_date <= w.end).length;

  return formats
    .map((format) => {
      const deckCount = countInWindow(format, currentWindow);
      const totalCurrent = totalCountInWindow(format, currentWindow);
      const totalPrev = totalCountInWindow(format, prevWindow);
      const prevCount = countInWindow(format, prevWindow);
      const rateCurrent = totalCurrent > 0 ? (deckCount / totalCurrent) * 100 : null;
      const ratePrev = totalPrev > 0 ? (prevCount / totalPrev) * 100 : null;
      const changePct =
        rateCurrent !== null && ratePrev !== null && ratePrev !== 0
          ? Math.round(((rateCurrent - ratePrev) / ratePrev) * 1000) / 10
          : null;
      return { format, deckCount, changePct };
    })
    .filter((f) => f.deckCount > 0)
    // フォーマットリーガル欄（固定のFORMATS順）と横に並べた時に行が揃うよう、
    // 件数順ではなくFORMATSの並び順に合わせる
    .sort(
      (a, b) =>
        (FORMATS as readonly string[]).indexOf(a.format) - (FORMATS as readonly string[]).indexOf(b.format),
    );
}
