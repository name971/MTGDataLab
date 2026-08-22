import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16ではmiddleware.tsはproxy.tsに改名されたが、そちらは常にNode.jsランタイムになり
// Cloudflare向けアダプター（opennextjs-cloudflare）がまだ対応していない
// （"Node.js middleware is not currently supported" エラーでデプロイが失敗した）。
// Edgeランタイムを使うには旧来のmiddleware.ts形式を使う必要がある
// （node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md参照）。
export function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
