import { NextRequest, NextResponse } from "next/server";
import { searchCardsInDb } from "@/lib/searchCards";
import { searchSampleCards } from "@/lib/sampleSearchIndex";
import { slugForCardName } from "@/lib/sampleCards";

/**
 * SearchBar（入力中のリアルタイムサジェスト）用API。
 * src/app/search/page.tsx（Enter送信後の検索結果ページ）と同じデータソース・
 * フォールバック方針（DB未ヒット時はサンプルデータ）を使い回す。
 */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";

  const dbResults = await searchCardsInDb(query);
  const results =
    dbResults.length > 0
      ? dbResults.map((r) => ({
          oracleId: slugForCardName(r.nameEn) ?? r.oracleId,
          nameJa: r.nameJa ?? r.nameEn,
          nameEn: r.nameEn,
          artCropUrl: r.artCropUrl,
        }))
      : searchSampleCards(query);

  return NextResponse.json({ results: results.slice(0, 8) });
}
