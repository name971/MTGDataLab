import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { LOCALES, type Locale } from "@/i18n/config";

// Next.js 16ではmiddleware.tsはproxy.tsに改名されたが、そちらは常にNode.jsランタイムになり
// Cloudflare向けアダプター（opennextjs-cloudflare）がまだ対応していない
// （"Node.js middleware is not currently supported" エラーでデプロイが失敗した）。
// Edgeランタイムを使うには旧来のmiddleware.ts形式を使う必要がある
// （node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md参照）。
//
// 2026-09-15、英語版対応でロケール振り分けをここに追加。/api・/authはURLが外部
// （Supabase/Google OAuthのコールバック設定、フロントのfetch呼び出し）に紐づくため
// ロケール接頭辞を付けない（[locale]配下に置かない設計、詳細は設計相談時のやり取り参照）。
const LOCALE_EXEMPT_PREFIXES = ["/api", "/auth"];

function hasLocalePrefix(pathname: string): boolean {
  return LOCALES.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
}

// 日本語を希望している場合だけja、それ以外（英語圏含む未指定）は米国市場向けにenを既定にする。
function preferredLocale(request: NextRequest): Locale {
  const acceptLanguage = request.headers.get("accept-language") ?? "";
  return acceptLanguage.toLowerCase().includes("ja") ? "ja" : "en";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!LOCALE_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) && !hasLocalePrefix(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${preferredLocale(request)}${pathname}`;
    return NextResponse.redirect(url);
  }

  return updateSession(request);
}

// robots.txtはNext.jsのファイル規約（src/app/robots.ts）でルート直下にしか生成されない。
// ロケール振り分けの対象からも除外しないと/ja/robots.txt等にリダイレクトされて404になる
// （2026-09-23判明、AIクローラー対策でrobots.tsを追加した際に発覚）。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
