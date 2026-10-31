import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** セッションCookieの自動リフレッシュ用（Supabase公式のNext.js SSRパターン）。
    root proxy.ts から呼ぶ。 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // 未ログイン（Supabaseの認証Cookie無し）なら更新するセッションが無い。クローラー等の大半の
  // リクエストでクライアント生成のCPU時間を省く（無料枠10ms対策、2026-10-31）。
  if (!request.cookies.getAll().some((c) => c.name.startsWith("sb-"))) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}
