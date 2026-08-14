-- ────────────────────────────────────────────────────────────
-- 【廃止済み・参考用】価格履歴アーカイブ用DB（Cloudflare D1、SQLite）
--
-- D1無料枠の日次読み書き行数上限（読み取り500万行/日、書き込み10万行/日）に達したため、
-- リクエスト数課金のCloudflare R2（カード単位NDJSON.gz、scripts/lib/r2PriceArchive.mjs・
-- src/lib/priceArchiveR2.ts参照）へ全面移行した。このスキーマ・テーブルはもう
-- 書き込まれない（既存データは残っているが、参照もしていない）。
--
-- 以下は移行前の設計メモ:
-- Supabase無料枠（Postgres 500MB）超過対策。直近60日程度はSupabaseの
-- card_cheapest_price_snapshotsに置いたまま、それより古い行はこちらに移し、
-- Supabase側からは削除する。カード詳細ページの価格推移グラフ「全期間」表示は、
-- 直近をSupabase・それ以前をこちらから取得して結合する（src/lib/dbCheapestPrice.ts）。
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS price_history_archive (
  oracle_id TEXT NOT NULL,
  date      TEXT NOT NULL, -- 'YYYY-MM-DD'
  jpy_est   REAL,
  jpy_est_foil REAL,
  -- その日の最安値がどのプリントだったか（価格推移グラフのホバーでセットシンボルを
  -- 出すため、card_prints側と突き合わせるscryfall_id）。無くても価格の集計自体には
  -- 影響しないため、無い期間（列追加より前のアーカイブ分）はNULLのまま許容する。
  scryfall_id TEXT,
  scryfall_id_foil TEXT,
  PRIMARY KEY (oracle_id, date)
);

CREATE INDEX IF NOT EXISTS idx_price_history_archive_oracle ON price_history_archive (oracle_id);

-- card_print_prices（Supabase、プリント単位・JSONB追記式）の古い日付分を移す。
-- こちらはUSD建てのまま持つ（Supabase側の元テーブルと同じ、円換算はJPY推定値が
-- 必要な読み取り側で行う）。プリント単位で95,000件超あり、card_cheapest_price_snapshots
-- （オラクル単位・33,000件強）より約3倍のペースで肥大化するため、こちらも同じ
-- 「直近だけSupabase・古い分はD1」方針をscripts/archive-old-print-prices.mjsで適用する。
CREATE TABLE IF NOT EXISTS print_price_history_archive (
  scryfall_id TEXT NOT NULL,
  date        TEXT NOT NULL, -- 'YYYY-MM-DD'
  usd         REAL,
  usd_foil    REAL,
  PRIMARY KEY (scryfall_id, date)
);

CREATE INDEX IF NOT EXISTS idx_print_price_history_archive_scryfall ON print_price_history_archive (scryfall_id);
