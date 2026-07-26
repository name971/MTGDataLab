import Image from "next/image";
import Link from "next/link";
import type { TrendingRankingRow } from "@/lib/dbTrendingRanking";

function changeClass(value: number) {
  return value >= 0 ? "text-teal-800" : "text-red-800";
}

export default function TrendingRankingList({ rows }: { rows: TrendingRankingRow[] }) {
  return (
    <ol className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200">
      {rows.map((row, index) => {
        const normalImageUrl = row.artCropUrl.replace("/art_crop/", "/normal/");
        return (
          <li key={row.oracleId}>
            <Link
              href={`/cards/${row.oracleId}`}
              className="flex items-center gap-3 p-2 hover:bg-neutral-50"
            >
              <span className="w-5 shrink-0 text-center text-sm text-neutral-400">{index + 1}</span>
              <Image
                src={normalImageUrl}
                alt={row.nameEn}
                width={40}
                height={56}
                className="shrink-0 rounded object-contain"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{row.nameJa}</p>
                <p className="truncate text-xs text-neutral-500">{row.nameEn}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5 text-sm">
                <span>¥{row.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</span>
                <span className="flex gap-2 text-xs">
                  {row.priceChangePct != null && (
                    <span className={changeClass(row.priceChangePct)}>
                      {row.priceChangePct >= 0 ? "+" : ""}
                      {row.priceChangePct.toFixed(1)}%
                    </span>
                  )}
                  {row.usageChangePt != null && (
                    <span className={changeClass(row.usageChangePt)}>
                      {row.usageChangePt >= 0 ? "+" : ""}
                      {row.usageChangePt.toFixed(1)}pt
                      {row.usageFormat ? `(${row.usageFormat})` : ""}
                    </span>
                  )}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
