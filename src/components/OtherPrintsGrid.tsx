"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { CardPrint } from "@/lib/dbCardPrints";

// 実物が角丸ではない（角が四角い）ことで知られるセットの一覧。角丸カードかどうかを毎回
// 判定するより、角が四角い方が少数派で既知のセットに限られるため、こちらを列挙する方が楽。
const SQUARE_CORNER_SET_CODES = new Set(["ced", "cei"]);

const VISIBLE_COUNT = 20;

export default function OtherPrintsGrid({
  oracleId,
  prints,
}: {
  oracleId: string;
  prints: CardPrint[];
}) {
  const [expanded, setExpanded] = useState(false);
  // 基本土地等は数百〜700件超のプリントがあり、全件表示すると見づらいため、
  // 最初は上位20件だけ出して「もっと見る」で展開する。
  const visible = expanded ? prints : prints.slice(0, VISIBLE_COUNT);

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8">
        {visible.map((p) => (
          <li key={p.scryfallId}>
            <Link
              href={`/cards/${oracleId}/prints/${p.scryfallId}`}
              className="flex flex-col gap-1 hover:opacity-80"
            >
              {p.imageUrl ? (
                <Image
                  src={p.imageUrl}
                  alt={p.setName}
                  width={146}
                  height={204}
                  className={`w-full ${SQUARE_CORNER_SET_CODES.has(p.setCode) ? "" : "rounded"}`}
                />
              ) : (
                <div className="flex aspect-[5/7] w-full items-center justify-center rounded bg-neutral-100 text-xs text-neutral-400">
                  画像なし
                </div>
              )}
              <span className="truncate text-xs text-neutral-600">{p.setName}</span>
              <span className="text-xs text-neutral-400">{p.releasedAt?.slice(0, 4) ?? "-"}</span>
            </Link>
          </li>
        ))}
      </ul>
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
