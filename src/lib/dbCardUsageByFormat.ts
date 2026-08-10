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

interface UsageCountRow {
  format: string;
  window_key: "current" | "prev";
  deck_count: number;
}

/**
 * 指定カード（oracle_id）が、各フォーマットで直近periodDays日間に何個のデッキで使われているかを
 * 集計する。カッコ内の増減率は、直前の同じ日数分・非重複のウィンドウとの比較（前期間比）。
 * 例: 7日間なら直前7日間、30日間なら直前30日間、90日間なら直前90日間と比較する。
 *
 * 以前はdeck_cards→decks→tournamentsの埋め込みJOINで該当行を丸ごとページング取得し、
 * deck_id単位の重複排除・フォーマット/期間ごとの絞り込みをJS側で行っていたが、
 * 採用数の多いカード（Sol Ring等、90日間で1万行近い）だと複数ページの逐次リクエストが
 * 発生し数秒〜十数秒かかっていた。集計自体をPostgres側のRPC関数
 * （card_usage_counts_by_format）に任せ、フォーマット×期間ごとの件数だけを受け取るように
 * した（転送行数を数万行から数行に削減）。
 */
export async function getFormatUsageCountsForCard(
  oracleId: string,
  periodDays: number = 7,
): Promise<FormatUsageCount[]> {
  const currentWindow = periodWindow(periodDays, 0);
  const prevWindow = periodWindow(periodDays, periodDays);

  const { data, error } = await supabase.rpc("card_usage_counts_by_format", {
    p_oracle_id: oracleId,
    p_period_days: periodDays,
  });
  if (error) return [];
  const usageRows = (data ?? []) as UsageCountRow[];

  const countByKey = new Map<string, number>();
  for (const row of usageRows) {
    countByKey.set(`${row.format}|${row.window_key}`, row.deck_count);
  }
  const countInWindow = (format: string, w: "current" | "prev") => countByKey.get(`${format}|${w}`) ?? 0;

  const formats = [...new Set(usageRows.map((r) => r.format))];
  if (formats.length === 0) return [];

  // 採用率(%)の分母（そのフォーマットの全デッキ数）は、このカードを含むかどうかに関わらない
  // 単なる件数なので、行データを転送してJSで数えるのではなくPostgresのcount機能で直接件数だけ
  // 取る（Commanderだけで直近7日に1000件を超えることがあり、以前は全行ページング取得していて
  // 遅かった）。フォーマット×現在/前期間の組み合わせを並列で問い合わせる。
  const totalCountEntries = await Promise.all(
    formats.flatMap((format) =>
      ([
        ["current", currentWindow],
        ["prev", prevWindow],
      ] as const).map(async ([key, w]) => {
        const { count } = await supabase
          .from("decks")
          .select("id, tournaments!inner(format, event_date)", { count: "exact", head: true })
          .eq("tournaments.format", format)
          .gte("tournaments.event_date", w.start)
          .lte("tournaments.event_date", w.end);
        return { format, key, count: count ?? 0 };
      }),
    ),
  );
  const totalCountByKey = new Map(totalCountEntries.map((e) => [`${e.format}|${e.key}`, e.count]));

  return formats
    .map((format) => {
      const deckCount = countInWindow(format, "current");
      const totalCurrent = totalCountByKey.get(`${format}|current`) ?? 0;
      const totalPrev = totalCountByKey.get(`${format}|prev`) ?? 0;
      const prevCount = countInWindow(format, "prev");
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
