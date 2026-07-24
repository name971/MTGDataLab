-- 検索機能: pg_trgmによる日英混在あいまい検索
-- 前提: card_oraclesテーブルに以下のインデックスを張る

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_card_oracles_name_trgm ON card_oracles USING GIN (name gin_trgm_ops);
CREATE INDEX idx_card_oracles_name_ja_trgm ON card_oracles USING GIN (printed_name_ja gin_trgm_ops);

-- 検索RPC関数。src/lib/searchCards.ts の searchCardsInDb() から呼び出す。
-- 英語名・日本語名どちらにも一致でき、類似度が高い順に返す。
CREATE OR REPLACE FUNCTION search_cards(query TEXT)
RETURNS TABLE(oracle_id UUID, name TEXT, printed_name_ja TEXT, score REAL) AS $$
  SELECT
    oracle_id,
    name,
    printed_name_ja,
    GREATEST(
      similarity(name, query),
      similarity(COALESCE(printed_name_ja, ''), query)
    ) AS score
  FROM card_oracles
  WHERE
    name ILIKE '%' || query || '%'
    OR printed_name_ja ILIKE '%' || query || '%'
    OR similarity(name, query) > 0.1
    OR similarity(COALESCE(printed_name_ja, ''), query) > 0.1
  ORDER BY score DESC
  LIMIT 8;
$$ LANGUAGE sql STABLE;

-- 呼び出し例（Supabase JSクライアント）:
-- const { data } = await supabase.rpc('search_cards', { query: 'ragavan' });
--
-- 運用メモ:
-- ・2〜3文字未満のクエリはアプリ側で発火させない（短すぎるとノイズが多すぎる）
-- ・ローマ字入力(「ragaban」等)への対応は初期スコープ外。需要を見て将来検討。


-- ════════════════════════════════════════════
-- カード名の名寄せ（トーナメント結果のカード名表記 → oracle_id）
-- ════════════════════════════════════════════
-- src/lib/nameMatching.ts の resolveOracleId() から呼び出すRPC関数。
-- reference/scripts/name-matching.ts（生のpg Clientで直接SQLを投げていた版）を
-- Supabaseクライアント経由で呼べるSQL関数に置き換えたもの。
-- 完全一致 → トライグラムのあいまい一致（閾値0.9）の優先順で1件だけ返す。
-- どちらにも一致しなければ0行を返す（呼び出し側でunmatched扱いにする）。
--
-- 閾値は元0.6だったが、"Savannah Lions"が全く別カードの"Savannah"（部分一致）に
-- 誤爆するなど、短い/部分文字列のカード名同士で偽陽性が多発したため0.9に引き上げた。
-- 0.9でも典型的なタイポ（1〜2文字の入れ替わり等）は拾えるが、単語単位で違う名前
-- （"Tear"→"Wear"、"Tolaria"→"Tolaria West"等）は一致しなくなる。

CREATE OR REPLACE FUNCTION resolve_oracle_id(input_name TEXT)
RETURNS TABLE(oracle_id UUID, match_type TEXT, score REAL) AS $$
  WITH exact_match AS (
    SELECT co.oracle_id, 'exact'::TEXT AS match_type, 1.0::REAL AS score
    FROM card_oracles co
    WHERE lower(trim(co.name)) = input_name
    LIMIT 1
  ),
  fuzzy_match AS (
    SELECT co.oracle_id, 'fuzzy'::TEXT AS match_type, similarity(lower(co.name), input_name) AS score
    FROM card_oracles co
    WHERE similarity(lower(co.name), input_name) > 0.9
    ORDER BY score DESC
    LIMIT 1
  )
  SELECT * FROM exact_match
  UNION ALL
  SELECT * FROM fuzzy_match WHERE NOT EXISTS (SELECT 1 FROM exact_match)
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- 呼び出し例（Supabase JSクライアント）:
-- const { data } = await supabase.rpc('resolve_oracle_id', { input_name: 'ragavan, nimble pilferer' });
