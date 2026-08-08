import { NextRequest, NextResponse } from "next/server";
import { getOtherPrintsForCard, getIconUrlBySetCodes, OTHER_PRINTS_PAGE_SIZE } from "@/lib/dbCardPrints";
import { getLatestPricesForPrints } from "@/lib/dbCardPrintPrices";

// クエリパラメータ（oracleId/offset/sortBy等）ごとに応答が変わるAPIなので、ISR/incremental cache
// （open-next.config.ts、Supabase egress対策で導入）に単一の静的レスポンスとしてキャッシュされる
// のを防ぐ。これが無いと、最初にキャッシュされたクエリの結果が他の全クエリにも返ってしまう。
export const dynamic = "force-dynamic";

/**
 * カード詳細ページ「その他のプリント」「画像一覧から探す」の続きページ取得用API。
 * 基本土地等の極端に版が多いカードでも、初回ページ読み込み時に全件（egress突出の原因だった）
 * を取得せず、この「もっと見る」操作の分だけ都度取得する（src/lib/dbCardPrints.ts参照）。
 * sortBy=price指定時はDB側で価格順ソート済みのページを返す（クライアント側で読み込み済み分
 * だけをソートすると、未読み込みの中にもっと安い/高いプリントが埋もれてしまうため）。
 */
export async function GET(request: NextRequest) {
  const oracleId = request.nextUrl.searchParams.get("oracleId");
  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const sortBy = request.nextUrl.searchParams.get("sortBy") === "price" ? "price" : "releaseDate";
  const sortDir = request.nextUrl.searchParams.get("sortDir") === "asc" ? "asc" : "desc";
  const finish = request.nextUrl.searchParams.get("finish") === "foil" ? "foil" : "normal";
  if (!oracleId || !Number.isFinite(offset) || offset < 0) {
    return NextResponse.json({ error: "oracleId and offset are required" }, { status: 400 });
  }

  const { prints, totalCount } = await getOtherPrintsForCard(
    oracleId,
    offset,
    OTHER_PRINTS_PAGE_SIZE,
    sortBy,
    sortDir,
    finish,
  );
  const [prices, iconUrlBySetCode] = await Promise.all([
    getLatestPricesForPrints(prints.map((p) => p.scryfallId)),
    getIconUrlBySetCodes(prints.map((p) => p.setCode)),
  ]);

  return NextResponse.json({
    prints,
    totalCount,
    pricesByScryfallId: Object.fromEntries(prices.normal),
    foilPricesByScryfallId: Object.fromEntries(prices.foil),
    iconUrlBySetCode,
  });
}
