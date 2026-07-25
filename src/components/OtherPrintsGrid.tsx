"use client";

import Link from "next/link";
import { useState } from "react";
import type { CardPrint } from "@/lib/dbCardPrints";

const VISIBLE_COUNT = 20;

export default function OtherPrintsGrid({
  oracleId,
  prints,
  pricesByScryfallId,
}: {
  oracleId: string;
  prints: CardPrint[];
  pricesByScryfallId: Record<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);
  // 基本土地等は数百〜700件超のプリントがあり、全件表示すると見づらいため、
  // 最初は上位20件だけ出して「もっと見る」で展開する。
  const visible = expanded ? prints : prints.slice(0, VISIBLE_COUNT);

  return (
    <div className="flex flex-col gap-3">
      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-auto" />
          <col className="w-20" />
        </colgroup>
        <tbody>
          {visible.map((p) => {
            const jpy = pricesByScryfallId[p.scryfallId];
            return (
              <tr key={p.scryfallId} className="border-b border-neutral-100 last:border-0">
                <td className="min-w-0 py-2 pr-2">
                  <Link
                    href={`/cards/${oracleId}/prints/${p.scryfallId}`}
                    className="flex min-w-0 items-center gap-2 text-neutral-700 hover:underline"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- ScryfallのSVGアイコンCDN、next/imageの最適化対象外の小さな外部SVG */}
                    <img
                      src={`https://svgs.scryfall.io/sets/${p.setCode}.svg`}
                      alt=""
                      width={14}
                      height={14}
                      className="shrink-0"
                    />
                    <span className="min-w-0 truncate">{p.setName}</span>
                  </Link>
                </td>
                <td className="overflow-hidden py-2 text-right text-ellipsis whitespace-nowrap tabular-nums text-neutral-700">
                  {jpy !== undefined ? `¥${jpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}` : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {prints.length > VISIBLE_COUNT && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="self-center rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:border-neutral-500"
        >
          {expanded ? "閉じる" : `もっと見る（残り${prints.length - VISIBLE_COUNT}件）`}
        </button>
      )}
    </div>
  );
}
