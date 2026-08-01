import Image from "next/image";
import Link from "next/link";
import { searchCardsInDb } from "@/lib/searchCards";
import { searchSampleCards } from "@/lib/sampleSearchIndex";
import { slugForCardName } from "@/lib/sampleCards";

export const metadata = { title: "検索 - MTG DataLab" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q ?? "";

  const dbResults = await searchCardsInDb(query);
  // DB検索がヒットしない場合（未インポートのクエリ等）はサンプルデータにフォールバックする
  const results =
    dbResults.length > 0
      ? dbResults.map((r) => ({
          oracleId: slugForCardName(r.nameEn) ?? r.oracleId,
          nameJa: r.nameJa ?? r.nameEn,
          nameEn: r.nameEn,
          artCropUrl: r.artCropUrl,
        }))
      : searchSampleCards(query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">検索結果: {query}</h1>
        <Link href="/search/advanced" className="text-sm text-neutral-500 hover:underline">
          高度検索 →
        </Link>
      </div>

      {results.length > 0 ? (
        <div className="flex flex-col gap-2">
          {results.map((card) => (
            <Link
              key={card.oracleId}
              href={`/cards/${card.oracleId}`}
              className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 hover:border-neutral-400"
            >
              {card.artCropUrl && (
                <Image
                  src={card.artCropUrl}
                  alt={card.nameEn}
                  width={40}
                  height={40}
                  className="h-10 w-10 shrink-0 rounded-md object-cover"
                />
              )}
              <div>
                <p className="text-sm font-medium">{card.nameJa}</p>
                <p className="text-xs text-neutral-500">{card.nameEn}</p>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          {query.trim().length < 2
            ? "2文字以上入力してください。"
            : "該当するカードが見つかりませんでした。"}
        </p>
      )}
    </div>
  );
}
