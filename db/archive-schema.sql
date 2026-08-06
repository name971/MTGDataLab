-- ────────────────────────────────────────────────────────────
-- 価格履歴アーカイブ用DB（Cloudflare D1、SQLite）
-- Supabase無料枠（Postgres 500MB）超過対策。直近90日程度はSupabaseの
-- card_cheapest_price_snapshotsに置いたまま、それより古い行はこちらに移し、
-- Supabase側からは削除する（scripts/archive-old-price-snapshots.mjs）。
-- カード詳細ページの価格推移グラフ「全期間」表示は、直近をSupabase・
-- それ以前をこちらから取得して結合する（src/lib/dbCheapestPrice.ts）。
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS price_history_archive (
  oracle_id TEXT NOT NULL,
  date      TEXT NOT NULL, -- 'YYYY-MM-DD'
  jpy_est   REAL,
  jpy_est_foil REAL,
  PRIMARY KEY (oracle_id, date)
);

CREATE INDEX IF NOT EXISTS idx_price_history_archive_oracle ON price_history_archive (oracle_id);
