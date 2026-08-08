import { NextRequest, NextResponse } from "next/server";
import { getPrintPriceHistory } from "@/lib/dbCardPrintPrices";

// クエリパラメータ（scryfallId/finish）ごとに応答が変わるAPIなので、ISR/incremental cache
// （open-next.config.ts、Supabase egress対策で導入）に単一の静的レスポンスとしてキャッシュされる
// のを防ぐ。これが無いと、最初にキャッシュされたプリントの価格推移が他の全プリントにも返ってしまう。
export const dynamic = "force-dynamic";

/**
 * カード詳細ページの「その他のプリント」をクリックしたときに、ページ遷移せず
 * メイン画像・価格・価格推移グラフだけをそのプリントのものに差し替えるためのAPI。
 * 全プリント分の履歴を事前にサーバー側で持たせると（基本土地は700件超）ページが重くなるため、
 * クリックされたプリントの分だけこのAPI経由で取得する。
 */
export async function GET(request: NextRequest) {
  const scryfallId = request.nextUrl.searchParams.get("scryfallId");
  if (!scryfallId) {
    return NextResponse.json({ error: "scryfallId is required" }, { status: 400 });
  }
  const finish = request.nextUrl.searchParams.get("finish") === "foil" ? "foil" : "normal";
  const history = await getPrintPriceHistory(scryfallId, finish);
  return NextResponse.json({ history });
}
