import { COLOR_ORDER, cmcFromManaCost } from "@/lib/manaColors";
import type { DeckCardDisplay } from "./DeckDetailView";

const COLOR_HEX: Record<string, string> = {
  W: "#f8f6d8",
  U: "#0e68ab",
  B: "#3a3a3a",
  R: "#d3202a",
  G: "#00733e",
};
const COLORLESS_HEX = "#9ca3af";

const CURVE_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"] as const;

function bucketForCmc(cmc: number): (typeof CURVE_BUCKETS)[number] {
  if (cmc >= 7) return "7+";
  return String(Math.floor(cmc)) as (typeof CURVE_BUCKETS)[number];
}

function isLand(card: DeckCardDisplay): boolean {
  return card.typeLine?.includes("Land") ?? false;
}

/**
 * デッキの土地枚数・色の割合・マナカーブを1画面に収まる簡易ステータスバーとして表示する。
 * メインボードのみを対象にする（Commanderの統率者はboard='side'なので自然に除外される）。
 * 色の割合は「1枚あたりそのカードに含まれる色を1つずつカウント」方式（ハイブリッド・
 * 多色は複数色にカウントされる）。マナシンボルの出現数まで厳密に数える「devotion」方式
 * ではなく、あくまで大まかな色の傾向を見るための簡易指標。
 */
export default function DeckStatsBar({ mainboard }: { mainboard: DeckCardDisplay[] }) {
  const totalCount = mainboard.reduce((sum, c) => sum + c.quantity, 0);
  const landCount = mainboard.filter(isLand).reduce((sum, c) => sum + c.quantity, 0);
  const nonLandCards = mainboard.filter((c) => !isLand(c));

  const colorCounts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let colorlessCount = 0;
  const curveCounts: Record<string, number> = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, 0]));

  for (const card of nonLandCards) {
    const colors = COLOR_ORDER.filter((c) => card.manaCost?.includes(c));
    if (colors.length === 0) {
      colorlessCount += card.quantity;
    } else {
      for (const c of colors) colorCounts[c] += card.quantity;
    }
    curveCounts[bucketForCmc(cmcFromManaCost(card.manaCost))] += card.quantity;
  }

  const totalColorWeight = Object.values(colorCounts).reduce((a, b) => a + b, 0) + colorlessCount;
  const maxCurveCount = Math.max(1, ...Object.values(curveCounts));

  if (totalCount === 0) return null;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4 sm:flex-row sm:gap-8">
      <div className="flex shrink-0 flex-col gap-3 sm:w-48">
        <div>
          <p className="text-xs text-neutral-500">土地</p>
          <p className="text-lg font-semibold">
            {landCount}
            <span className="text-sm font-normal text-neutral-500">/{totalCount}枚</span>
          </p>
        </div>
        {totalColorWeight > 0 && (
          <div>
            <p className="mb-1 text-xs text-neutral-500">色の割合</p>
            <div className="flex h-3 w-full overflow-hidden rounded-full">
              {COLOR_ORDER.filter((c) => colorCounts[c] > 0).map((c) => (
                <div
                  key={c}
                  style={{
                    width: `${(colorCounts[c] / totalColorWeight) * 100}%`,
                    backgroundColor: COLOR_HEX[c],
                  }}
                  title={`${c}: ${colorCounts[c]}枚`}
                />
              ))}
              {colorlessCount > 0 && (
                <div
                  style={{
                    width: `${(colorlessCount / totalColorWeight) * 100}%`,
                    backgroundColor: COLORLESS_HEX,
                  }}
                  title={`無色: ${colorlessCount}枚`}
                />
              )}
            </div>
            {/* バーの色比だけだと枚数が薄い色（1〜2枚のタッチ等）は見えづらいため、
                色ごとの内訳をチップで数値と一緒に出す（ホバー無しで一目で分かるように） */}
            <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 gap-y-1">
              {COLOR_ORDER.filter((c) => colorCounts[c] > 0).map((c) => (
                <span key={c} className="flex flex-col items-center gap-0.5 text-xs text-neutral-600">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-300"
                    style={{ backgroundColor: COLOR_HEX[c] }}
                  />
                  {colorCounts[c]}
                </span>
              ))}
              {colorlessCount > 0 && (
                <span className="flex flex-col items-center gap-0.5 text-xs text-neutral-600">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-300"
                    style={{ backgroundColor: COLORLESS_HEX }}
                  />
                  {colorlessCount}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1">
        <p className="mb-1 text-xs text-neutral-500">マナカーブ（土地除く）</p>
        <div className="flex h-24 items-end gap-1.5">
          {CURVE_BUCKETS.map((bucket) => (
            <div key={bucket} className="flex flex-1 flex-col items-center gap-1">
              {/* バーの高さの見た目だけだと枚数が伝わりづらいため、バーの上に枚数を常時表示する
                  （0枚の帯も高さを揃えるため空文字ではなくスペースで場所だけ確保） */}
              <span className="text-xs leading-none font-medium text-neutral-700">
                {curveCounts[bucket] > 0 ? curveCounts[bucket] : " "}
              </span>
              <div className="flex h-16 w-full items-end">
                <div
                  className="w-full rounded-t bg-neutral-400"
                  style={{ height: `${(curveCounts[bucket] / maxCurveCount) * 100}%` }}
                  title={`CMC ${bucket}: ${curveCounts[bucket]}枚`}
                />
              </div>
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-300 text-[10px] text-neutral-600">
                {bucket}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
