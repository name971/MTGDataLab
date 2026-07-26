import { NextRequest, NextResponse } from "next/server";
import { getPrintPriceHistory } from "@/lib/dbCardPrintPrices";

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
