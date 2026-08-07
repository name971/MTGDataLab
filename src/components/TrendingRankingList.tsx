import Image from "next/image";
import Link from "next/link";
import type { TrendingRankingRow } from "@/lib/dbTrendingRanking";

function changeClass(value: number) {
  return value >= 0 ? "text-teal-800" : "text-red-800";
}

export default function TrendingRankingList({ rows }: { rows: TrendingRankingRow[] }) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-5">
      {rows.map((row, index) => (
        <TrendingRankRow key={row.oracleId} row={row} rank={index + 1} />
      ))}
    </div>
  );
}

function TrendingRankRow({ row, rank }: { row: TrendingRankingRow; rank: number }) {
  // カードそのものを見分けられることが重要なので、アートクロップではなくカード全体の画像を使う。
  // Scryfallの画像URLは/<バリエーション>/front/<...>.jpgという共通構造なので置換で導出できる。
  const normalImageUrl = row.artCropUrl.replace("/art_crop/", "/normal/");

  return (
    <Link
      href={`/cards/${row.oracleId}`}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
    >
      <Image
        src={normalImageUrl}
        alt={row.nameEn}
        width={223}
        height={311}
        className="w-full object-contain"
      />
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium">
          <span className="mr-1.5 text-neutral-400">{rank}</span>
          {row.nameJa}
        </p>
        <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>

        {/* 価格変化率(%)と採用率変化(pt)は単位が違って直接比較できないため、ランキングの
            根拠になっている相対注目度（このランキング内の最上位=100とした0〜100）をバーで見せる。
            生の%/ptは下に補足情報として添えるのみで、順位の理由には使わない。 */}
        <div className="mt-1 flex items-center gap-1.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full bg-purple-500"
              style={{ width: `${row.attentionScore}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-neutral-500">注目度{row.attentionScore}</span>
        </div>

        <div className="mt-0.5 flex items-start justify-between text-xs text-neutral-500">
          {row.priceChangePct != null && (
            <span className={changeClass(row.priceChangePct)}>
              価格 {row.priceChangePct >= 0 ? "+" : ""}
              {row.priceChangePct.toFixed(1)}%
            </span>
          )}
          {row.usageChangePt != null && (
            <span className={changeClass(row.usageChangePt)}>
              採用率{row.usageFormat ? `(${row.usageFormat})` : ""} {row.usageChangePt >= 0 ? "+" : ""}
              {row.usageChangePt.toFixed(1)}pt
            </span>
          )}
        </div>
        <p className="text-right text-sm">
          ¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
        </p>
      </div>
    </Link>
  );
}
