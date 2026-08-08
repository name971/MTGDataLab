import { NextRequest, NextResponse } from "next/server";
import { searchCardsInDb } from "@/lib/searchCards";
import { searchSampleCards } from "@/lib/sampleSearchIndex";
import { slugForCardName } from "@/lib/sampleCards";

// クエリ（q）ごとに応答が変わるAPIなので、ISR/incremental cache（open-next.config.ts、
// Supabase egress対策で導入）に単一の静的レスポンスとしてキャッシュされるのを防ぐ。
// これが無いと、最初にキャッシュされた検索語の結果が他の全ての検索語にも返ってしまう。
export const dynamic = "force-dynamic";

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
