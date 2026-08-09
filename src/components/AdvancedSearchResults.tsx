"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { AdvancedSearchResult } from "@/lib/dbAdvancedSearch";

const RARITY_LABEL_JA_CLIENT: Record<string, string> = {
  common: "コモン",
  uncommon: "アンコモン",
  rare: "レア",
  mythic: "神話レア",
};

/**
 * 高度検索の結果一覧。初回分（PAGE_SIZE件）はページ側でSSR取得済みのものをそのまま表示し、
 * 「もっと見る」を押した時だけ/api/advanced-searchから続きを取得して追記する（全件を一度に
 * 返すと候補数が多い時に重いため、読み込み式にして負荷を抑えている）。
 */
export default function AdvancedSearchResults({
  initialResults,
  totalCount,
  queryString,
}: {
  initialResults: AdvancedSearchResult[];
  totalCount: number;
  /** 現在のフィルタ条件をそのまま/api/advanced-searchに渡すためのクエリ文字列（offsetは含まない） */
  queryString: string;
}) {
  const [results, setResults] = useState(initialResults);
  const [loading, setLoading] = useState(false);
  const hasMore = results.length < totalCount;

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/advanced-search?${queryString}&offset=${results.length}`);
      const data = (await res.json()) as { results: AdvancedSearchResult[]; totalCount: number };
      setResults((prev) => [...prev, ...data.results]);
    } catch {
      // 失敗時は何もしない。ボタンをもう一度押せば再試行できる。
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-500">{totalCount}件ヒット</p>
      {results.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {results.map((card) => (
              <Link
                key={card.oracleId}
                href={`/cards/${card.oracleId}`}
                className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-400"
              >
                {card.imageUrl && (
                  <Image
                    src={card.imageUrl}
                    alt={card.nameEn}
                    width={223}
                    height={311}
                    className="w-full object-contain"
                  />
                )}
                <div className="flex flex-col gap-0.5 p-2">
                  <p className="truncate text-sm font-medium">{card.nameJa ?? card.nameEn}</p>
                  <p className="truncate text-xs text-neutral-500">{card.nameEn}</p>
                  <div className="mt-1 flex items-center justify-between text-xs text-neutral-500">
                    <span>{RARITY_LABEL_JA_CLIENT[card.rarity] ?? card.rarity}</span>
                    <span>
                      {card.priceJpy !== null
                        ? `¥${card.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`
                        : "-"}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loading}
              className="self-center rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:border-neutral-500 disabled:opacity-50"
            >
              {loading ? "読み込み中…" : `もっと見る（残り${totalCount - results.length}件）`}
            </button>
          )}
        </>
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">条件に一致するカードが見つかりませんでした。</p>
      )}
    </div>
  );
}
