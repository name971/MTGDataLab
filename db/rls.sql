-- RLS（行レベルセキュリティ）の有効化。2026-11-16のコードレビューで作成、【未適用】。
--
-- 背景: favorite_cards / price_alerts 以外の22テーブルでRLSが無効で、ブラウザに配っている
-- anonキーだけで全テーブルのINSERT/UPDATE/DELETEができる状態だった。
--
-- 適用の前提（順番を守ること。逆にすると日次バッチの書き込みが全部止まる）:
--   1. Supabaseダッシュボード > Settings > API の service_role キーを、
--      GitHubのシークレット SUPABASE_SERVICE_ROLE_KEY と .env.local に入れる
--      （NEXT_PUBLIC_ を付けない。Workerには渡さない）
--   2. 日次パイプラインを1回流し、書き込みが成功することを確認する
--   3. このファイルを適用する
--   4. もう一度パイプラインを流し、サイトの表示と合わせて確認する
-- 戻し方: 各テーブルで ALTER TABLE ... DISABLE ROW LEVEL SECURITY;

BEGIN;

-- 1) 公開データ（カード・価格・デッキ・ランキング）: 誰でも読める、書けるのはservice_roleだけ
--    （service_roleはRLSを素通りするので書き込み用のポリシーは不要）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'archetype_price_stats','archetypes','card_cheapest_price_snapshots','card_current_prices',
    'card_oracles','card_price_predictions','card_print_current_prices','card_print_prices',
    'card_prints','card_usage_stats','cards','deck_cards','decks','exchange_rates',
    'format_settings','language_premium_stats','sealed_price_snapshots','sets','tournaments',
    'trending_scores','weekly_movers'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "public read" ON public.%I', t);
    EXECUTE format('CREATE POLICY "public read" ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- 2) users（email列あり・現在0行・コードから未使用）: ポリシー無し＝anon/authenticatedは一切触れない
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users FROM anon, authenticated;

-- 3) 個人データ: ログイン中の本人だけ。auth.uid()を行ごとに再評価しないよう(select ...)で包む
DROP POLICY IF EXISTS "own favorites only" ON public.favorite_cards;
CREATE POLICY "own favorites only" ON public.favorite_cards FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "own alerts only" ON public.price_alerts;
CREATE POLICY "own alerts only" ON public.price_alerts FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
REVOKE ALL ON public.favorite_cards, public.price_alerts FROM anon;

-- 4) 関数: SECURITY DEFINER を匿名で呼べないようにし、search_path を固定する
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_database_size_bytes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_database_size_bytes() TO service_role;  -- scripts/check-db-size.mjs 用
ALTER FUNCTION public.search_cards(text) SET search_path = public;
ALTER FUNCTION public.resolve_oracle_id(text) SET search_path = public;
ALTER FUNCTION public.mana_value_from_cost(text) SET search_path = public;
ALTER FUNCTION public.card_usage_counts_by_format(uuid, integer) SET search_path = public;

COMMIT;

-- 適用後の確認（rls=false の行が0件、anonの書き込み権限が無いこと）:
-- select c.relname, c.relrowsecurity, has_table_privilege('anon', c.oid, 'INSERT') as anon_insert
-- from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;
