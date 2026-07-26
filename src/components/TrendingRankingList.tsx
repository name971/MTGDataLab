import Image from "next/image";
import Link from "next/link";
import type { TrendingRankingRow } from "@/lib/dbTrendingRanking";

function changeClass(value: number) {
  return value >= 0 ? "text-teal-800" : "text-red-800";
}

export default function TrendingRankingList({ rows }: { rows: TrendingRankingRow[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
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
        <div className="mt-1 flex items-start justify-between text-sm">
          {row.priceChangePct != null && (
            <span className="flex flex-col">
              <span className="text-xs text-neutral-400">価格変化率</span>
              <span className={changeClass(row.priceChangePct)}>
                {row.priceChangePct >= 0 ? "+" : ""}
                {row.priceChangePct.toFixed(1)}%
              </span>
            </span>
          )}
          {row.usageChangePt != null && (
            <span className="flex flex-col items-end">
              <span className="text-xs text-neutral-400">
                採用率変化{row.usageFormat ? `(${row.usageFormat})` : ""}
              </span>
              <span className={changeClass(row.usageChangePt)}>
                {row.usageChangePt >= 0 ? "+" : ""}
                {row.usageChangePt.toFixed(1)}pt
              </span>
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
