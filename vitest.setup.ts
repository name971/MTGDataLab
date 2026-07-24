/**
 * テスト実行時、Supabaseクライアントの初期化（src/lib/supabase.ts）が
 * 環境変数未設定で例外を投げないようにするためのダミー値。
 * 実際のSupabaseへの接続はテストでは発生しない（RPC呼び出しを伴うテストは別途モックする）。
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
