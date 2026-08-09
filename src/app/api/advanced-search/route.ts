import { NextRequest, NextResponse } from "next/server";
import { advancedSearchCards, PAGE_SIZE } from "@/lib/dbAdvancedSearch";
import { parseAdvancedSearchFilters, type RawSearchParams } from "@/lib/parseAdvancedSearchParams";

// クエリパラメータ（フィルタ条件・offset）ごとに応答が変わるAPIなので、ISR/incremental cache
// （open-next.config.ts、Supabase egress対策で導入）に単一の静的レスポンスとしてキャッシュされる
// のを防ぐ（/api/other-prints等で実際に踏んだのと同じ問題）。
export const dynamic = "force-dynamic";

/**
 * 高度検索の「もっと見る」用API。初回表示はページ側でSSR取得するが、続きのページは
 * 全件（最大500件）を一度に返すと重いため、この API経由でPAGE_SIZEずつ追加取得する。
 */
export async function GET(request: NextRequest) {
  const sp: RawSearchParams = {};
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (key === "offset") continue;
    const existing = sp[key];
    if (existing === undefined) sp[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else sp[key] = [existing, value];
  }
  const filters = parseAdvancedSearchFilters(sp);
  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  if (!Number.isFinite(offset) || offset < 0) {
    return NextResponse.json({ error: "invalid offset" }, { status: 400 });
  }

  const page = await advancedSearchCards(filters, offset, PAGE_SIZE);
  return NextResponse.json(page);
}
