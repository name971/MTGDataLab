-- ────────────────────────────────────────────────────────────
-- 日本語版MTGStocks データベーススキーマ
-- PostgreSQL / Supabase 想定
-- ────────────────────────────────────────────────────────────


-- cards.mana_valueの生成列が使う関数。mana_cost（例:"{2}{W/U}{B}"）中の{...}記号を全て合算する。
-- X/Y/Zは0、数値記号はその数値、それ以外（色記号・ハイブリッド・Phyrexian等）は1として数える。
-- 生成列（CREATE TABLE cards内）より前に定義しておく必要がある
-- （2026-08-20、末尾に定義していたため新規プロジェクトへのスキーマ適用時にcardsテーブル作成が
-- 失敗する不具合が発覚。以前は既存DBに後付けで関数を追加していたため気づかれなかった）。
CREATE OR REPLACE FUNCTION mana_value_from_cost(mana_cost TEXT) RETURNS INTEGER AS $$
DECLARE
  total INTEGER := 0;
  sym TEXT;
BEGIN
  IF mana_cost IS NULL THEN RETURN 0; END IF;
  FOR sym IN SELECT (regexp_matches(mana_cost, '\{([^}]+)\}', 'g'))[1] LOOP
    IF sym IN ('X','Y','Z') THEN
      total := total + 0;
    ELSIF sym ~ '^[0-9]+$' THEN
      total := total + sym::INTEGER;
    ELSE
      total := total + 1;
    END IF;
  END LOOP;
  RETURN total;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ════════════════════════════════════════════
-- 1. カードマスタ（Scryfall由来）
-- ════════════════════════════════════════════

-- 「カードの概念」単位（oracle_id）。再録があっても1行。
-- ランキング・採用率・トレンドスコアなど、プリント違いを問わない集計はここを参照する。
-- is_reserved/is_serializedは以前マイグレーションで追加され、scripts/import-full-catalog.mjs
-- 等が実際に書き込んでいたが、このファイル自体への反映が漏れていた
-- （2026-08-20、新規プロジェクトへスキーマ適用時に列不足エラーで発覚）。
CREATE TABLE card_oracles (
  oracle_id       UUID PRIMARY KEY,
  name            TEXT NOT NULL,
  printed_name_ja TEXT,
  oracle_text     TEXT, -- ルールテキスト（英語）。カード詳細ページ表示用
  is_reserved     BOOLEAN NOT NULL DEFAULT false,
  is_serialized   BOOLEAN NOT NULL DEFAULT false
);

-- カードの「印刷」単位（セット違い・言語違いごとに1行）
CREATE TABLE cards (
  scryfall_id        UUID PRIMARY KEY,
  oracle_id           UUID NOT NULL REFERENCES card_oracles (oracle_id),
  name                TEXT NOT NULL,
  printed_name_ja     TEXT,
  printed_text_ja     TEXT, -- ルールテキストの日本語訳（日本語版プリントのみ）
  set_code            TEXT NOT NULL,
  set_name            TEXT NOT NULL,
  rarity              TEXT NOT NULL,             -- common/uncommon/rare/mythic
  collector_number    TEXT NOT NULL,
  lang                TEXT NOT NULL DEFAULT 'en',
  image_uri_normal    TEXT,                      -- Scryfall画像URL（直リンク、自前ホストしない）
  image_uri_art_crop  TEXT,
  mana_cost           TEXT,
  type_line            TEXT,
  printed_type_line    TEXT, -- タイプ行の日本語訳（日本語版プリントのみ。type_lineは常に英語）
  power               TEXT, -- "*"や"1+*"等の非数値もあるためTEXT（Scryfallの型に合わせる）。クリーチャー以外はNULL
  toughness           TEXT,
  legalities          JSONB,                     -- {"modern": "legal", "standard": "not_legal", ...}
  released_at         DATE,                      -- このプリントの発売日（日本語名の「最新版採用」判定に使う）
  finishes             TEXT[],                    -- ['nonfoil','foil'] 等（Scryfallのfinishesをそのまま保存）
  is_showcase          BOOLEAN DEFAULT false,
  is_borderless        BOOLEAN DEFAULT false,
  is_promo             BOOLEAN DEFAULT false,
  is_universes_beyond  BOOLEAN DEFAULT false, -- promo_typesに"universesbeyond"を含むか（コラボ作品プリント）
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- mana_costから計算した数値のマナ総量（生成列、インデックス済み）。高度検索のマナ総量フィルタを
  -- SQL側で完結させるために追加した（以前はJS側でmana_costをパースしていたため、該当が少ない
  -- 条件だと候補を集めるのに何度もページを取りに行く必要があり遅かった）。
  -- 計算ロジックはsrc/lib/parseAdvancedSearchParams.ts等のJS版と同じ（X/Y/Zは0、
  -- ハイブリッド/Phyrexianは1として数える。分割/両面カードの裏面もまとめて合算する）。
  -- 定義: mana_value_from_cost(TEXT) SQL関数（マイグレーション履歴参照）
  mana_value          INTEGER GENERATED ALWAYS AS (mana_value_from_cost(mana_cost)) STORED
);

CREATE INDEX IF NOT EXISTS idx_cards_mana_value ON cards (mana_value);

-- 代表プリントの選定ルール（一覧・ランキングでどのプリントの画像/価格を使うか）:
-- 1. 通常版nonfoil（is_showcase/is_borderless/is_promoが全てfalse、finishesにnonfoilを含む）があればそれを優先
-- 2. 該当がなければ、Scryfallから取得した現在価格が最安のものを採用
-- 判定タイミングでScryfallから直接取得した現在価格を使う（全プリントの日次履歴は持たないため）。
-- 再評価は新セット追加時・再録検知時など、代表プリントが変わりうるタイミングでのみ実行すれば十分。
--
-- SELECT c.* FROM cards c
-- WHERE c.oracle_id = :oracle_id
-- ORDER BY
--   ('nonfoil' = ANY(c.finishes) AND NOT c.is_showcase AND NOT c.is_borderless AND NOT c.is_promo) DESC,
--   c.current_usd_from_scryfall ASC  -- バッチ実行時にScryfallから都度取得した値（保存はしない）
-- LIMIT 1;

-- card_oracles.printed_name_ja の更新ルール（日次バッチ）:
-- エラッタ等で再録時に日本語名が変わるケースがあるため、単純な「最初に見つけた日本語名」で
-- 固定してはいけない。必ず「日本語版プリントのうち発売日が最新のもの」の printed_name を採用する。
--
-- UPDATE card_oracles co
-- SET printed_name_ja = latest.printed_name_ja
-- FROM (
--   SELECT DISTINCT ON (oracle_id) oracle_id, printed_name_ja
--   FROM cards
--   WHERE lang = 'ja'
--   ORDER BY oracle_id, released_at DESC
-- ) latest
-- WHERE co.oracle_id = latest.oracle_id;

CREATE INDEX idx_cards_oracle_id ON cards (oracle_id);
CREATE INDEX idx_cards_name ON cards (name);
CREATE INDEX idx_cards_set_code ON cards (set_code);

-- 「代表プリント」を1枚選ぶためのビュー的な考え方はアプリ側で実装
-- （直近セットの再録 or 一番安いプリントを代表として採用、等）

-- カード詳細ページ「その他のプリント」欄用。cardsテーブルは代表プリント1枚だけを保持する
-- 設計（データ肥大化対策）のため、表示専用の軽量な全プリント一覧を別テーブルに持つ。
-- 価格は追跡しない（画像・セット名・発売年のみ）。scripts/rebuild-card-prints.mjsが
-- Scryfallバルクデータから英語版nonfoil/非デジタルのプリントのみを対象に生成する
-- （新セット追加時など、代表プリントが変わりうるタイミングで再実行すれば十分。日次不要）。
-- セットコード→セット名の対応表。card_printsは10万行超あり、set_nameを毎行フルテキストで
-- 重複保持すると容量を無駄に食うため、正規化して数百行のこちらだけに持たせる。
CREATE TABLE sets (
  set_code TEXT PRIMARY KEY,
  set_name TEXT NOT NULL,
  -- Scryfallのセットシンボル画像URL。ScryfallのカードバルクデータにはSecret Lair Drop等の
  -- 特殊セットのアイコンURLが含まれない（`https://svgs.scryfall.io/sets/<set_code>.svg`という
  -- 命名規則が成り立たないセットがある、例: sld → star.svg）ため、Scryfallの/setsエンドポイント
  -- （scripts/backfill-set-icons.mjs）から別途取得して埋める。無ければNULL（表示側でフォールバック）。
  icon_svg_uri TEXT
);

CREATE TABLE card_prints (
  scryfall_id          UUID PRIMARY KEY,
  oracle_id            UUID NOT NULL REFERENCES card_oracles (oracle_id),
  set_code             TEXT NOT NULL REFERENCES sets (set_code),
  collector_number     TEXT NOT NULL,
  released_at          DATE,
  image_uri_normal     TEXT,
  -- 日本語版プリントの画像（存在する場合のみ）。「その他のプリント」欄は可能な限り
  -- 日本語版の画像を出したいが、日本語版が存在しないプリントも多いため、image_uri_normal
  -- （英語版、常に存在）とは別カラムで持つ（呼び出し側でimage_uri_normal_ja ?? image_uri_normal）。
  image_uri_normal_ja  TEXT,
  -- このプリント固有のレアリティ（同じカードでも再録時にレアリティが変わることがあるため、
  -- oracle単位ではなくプリント単位で持つ。「カードデータ」欄で過去に出た全レアリティを
  -- 集計表示するのに使う）
  rarity               TEXT,
  -- 金縁(World Championship Decks等)・銀縁(Un-set)・memorabilia区分(30th Anniversary Edition等)は
  -- オラクルとしては合法でも、この物理プリント自体はどのフォーマットでも使用不可
  -- （border_colorが標準の黒/白以外、またはset_typeが非トーナメント区分）。
  not_tournament_legal BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_prints_oracle_id ON card_prints (oracle_id);

-- 【廃止予定・新規書き込み停止済み】card_prints（全プリント、10万件超）の日次価格履歴。
-- 1プリント=1行、日付ごとの価格をJSONBに追記していく方式（例: {"2026-07-25": 123.45, ...}）
-- だったが、それでも無期限に増え続けてSupabase無料枠（500MB）を圧迫し続けたため、
-- scripts/snapshot-print-prices.mjsは新規の日付をこのテーブルに書かなくなった
-- （代わりにcard_print_current_prices＝今の価格キャッシュとD1＝日次履歴に書く。
-- DB容量超過対応）。既存の行はscripts/archive-old-print-prices.mjsが60日経過後に
-- D1へ吸い出して削除するため、時間経過とともに空になっていく（完全に空になったら
-- このテーブル自体を削除してよい）。
CREATE TABLE card_print_prices (
  scryfall_id UUID PRIMARY KEY REFERENCES card_prints (scryfall_id),
  oracle_id   UUID NOT NULL REFERENCES card_oracles (oracle_id),
  prices      JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"YYYY-MM-DD": usd円換算前のUSD価格}
  prices_foil JSONB NOT NULL DEFAULT '{}'::jsonb, -- 同上のFoil版（Foil仕様が無いプリントは追記されないので空のまま）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_print_prices_oracle_id ON card_print_prices (oracle_id);

-- card_print_pricesと同じ理由（DB容量超過対応）で新設した、プリント単位の「今の価格」キャッシュ。
CREATE TABLE card_print_current_prices (
  scryfall_id UUID PRIMARY KEY REFERENCES card_prints (scryfall_id),
  oracle_id   UUID NOT NULL REFERENCES card_oracles (oracle_id),
  date        DATE NOT NULL,
  usd         NUMERIC(10, 2),
  usd_foil    NUMERIC(10, 2),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_print_current_prices_oracle ON card_print_current_prices (oracle_id);

-- 【廃止予定・新規書き込み停止済み】オラクル単位・日付単位で「その日、全プリント中で
-- 一番安かった価格」を集計したもの。card_print_pricesと同じ理由で、
-- scripts/compute-cheapest-price-snapshots.mjsは新規の日付をこのテーブルに書かなくなり、
-- 代わりにcard_current_prices（今の価格キャッシュ）とD1（日次履歴）に書く
-- （DB容量超過対応）。既存の行はscripts/archive-old-price-snapshots.mjsが60日経過後に
-- D1へ吸い出して削除するため、時間経過とともに空になっていく。
CREATE TABLE card_cheapest_price_snapshots (
  oracle_id       UUID NOT NULL REFERENCES card_oracles (oracle_id),
  date            DATE NOT NULL,
  scryfall_id     UUID REFERENCES card_prints (scryfall_id), -- その日最安だった通常プリント
  usd             NUMERIC(10, 2),
  jpy_est         NUMERIC(12, 2),
  scryfall_id_foil UUID REFERENCES card_prints (scryfall_id), -- その日最安だったFoilプリント
  usd_foil        NUMERIC(10, 2),
  jpy_est_foil    NUMERIC(12, 2),
  PRIMARY KEY (oracle_id, date)
);

CREATE INDEX idx_card_cheapest_price_oracle_date ON card_cheapest_price_snapshots (oracle_id, date);

-- 「今の価格」だけを1オラクル1行で持つキャッシュ。日次の全履歴は（この下のcard_print_prices
-- 含めて）D1（jp-mtgstocks-archive、db/archive-schema.sql）へ直接書くように変更したため、
-- Postgres側で「最新価格」を高速に引くための代替として新設した（DB容量超過対応）。
-- card_cheapest_price_snapshots / card_print_pricesは新規の日付が追記されなくなり、
-- 既存の古い行はscripts/archive-old-price-snapshots.mjs等が60日経過後にD1へ吸い出して
-- 削除するため、時間経過とともに空になっていく想定（完全に空になったら削除してよい）。
CREATE TABLE card_current_prices (
  oracle_id        UUID PRIMARY KEY REFERENCES card_oracles (oracle_id),
  date             DATE NOT NULL,
  scryfall_id      UUID REFERENCES card_prints (scryfall_id),
  usd              NUMERIC(10, 2),
  jpy_est          NUMERIC(12, 2),
  scryfall_id_foil UUID REFERENCES card_prints (scryfall_id),
  usd_foil         NUMERIC(10, 2),
  jpy_est_foil     NUMERIC(12, 2),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ════════════════════════════════════════════
-- 2. 価格データ（日次スナップショット）
-- ════════════════════════════════════════════

-- 為替レート（Frankfurter APIから日次取得）
CREATE TABLE exchange_rates (
  date        DATE PRIMARY KEY,
  usd_to_jpy  NUMERIC(10, 4) NOT NULL,
  eur_to_jpy  NUMERIC(10, 4) NOT NULL
);

-- card_price_snapshots（代表プリント単体の日次価格）は§8参照の理由で削除済み。
-- 現在の日次価格スナップショットはcard_cheapest_price_snapshots（全プリント横断の最安値、
-- このファイル後半）とcard_print_prices（プリント単位、JSONB追記式）の2本立てで持つ。

-- シールド商品（パック・ボックス）の日次スナップショット（TCGCSV由来）
CREATE TABLE sealed_price_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  set_code          TEXT NOT NULL,
  product_type      TEXT NOT NULL,   -- 'play_booster' | 'collector_booster' | 'booster_box' 等
  date              DATE NOT NULL,
  usd_market_price  NUMERIC(10, 2),
  jpy_est           NUMERIC(12, 2),
  UNIQUE (set_code, product_type, date)
);

-- 言語プレミアム用（将来対応・未実装。TCGTracking等のSKU単位価格を想定）
-- 言語プレミアム（EN版とJP版の価格差）は新規の外部データソース不要で、既存のcards/
-- card_print_prices（プリント単位のJSONB日次価格）だけから計算できる。対象はScryfallが
-- JP版プリントに独自のUSD価格を持つカードのみ（対象は限定的）。
-- 日次バッチで計算しキャッシュする想定（下の集計例は旧card_price_snapshots前提の擬似コードなので
-- 実装時はcard_print_pricesのJSONB演算子ベースで書き直すこと）。
CREATE TABLE language_premium_stats (
  id              BIGSERIAL PRIMARY KEY,
  oracle_id       UUID NOT NULL REFERENCES card_oracles (oracle_id),
  en_price_jpy    NUMERIC(12, 2) NOT NULL,
  ja_price_jpy    NUMERIC(12, 2) NOT NULL,
  premium_ratio   NUMERIC(6, 2) NOT NULL,   -- ja_price / en_price
  calculated_date DATE NOT NULL,
  UNIQUE (oracle_id, calculated_date)
);

CREATE INDEX idx_language_premium_lookup ON language_premium_stats (calculated_date, premium_ratio DESC);

-- 集計クエリの例（バッチ処理で日次実行）:
-- INSERT INTO language_premium_stats (oracle_id, en_price_jpy, ja_price_jpy, premium_ratio, calculated_date)
-- SELECT
--   en.oracle_id, en.jpy_est, ja.jpy_est,
--   ROUND((ja.jpy_est / en.jpy_est)::numeric, 2), CURRENT_DATE
-- FROM card_price_snapshots en
-- JOIN card_price_snapshots ja
--   ON ja.oracle_id = en.oracle_id AND ja.date = en.date AND ja.series = 'ja'
-- WHERE en.series = 'en' AND en.date = CURRENT_DATE
--   AND en.usd IS NOT NULL AND ja.usd IS NOT NULL;


-- ════════════════════════════════════════════
-- 3. トーナメント・デッキデータ
-- ════════════════════════════════════════════

CREATE TABLE tournaments (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,        -- 'mtgo' | 'topdeck'
  source_event_id TEXT NOT NULL,      -- 取得元でのイベントID（重複取得防止用）
  format        TEXT NOT NULL,        -- 'Standard' | 'Modern' | ...
  event_name    TEXT NOT NULL,
  event_date    DATE NOT NULL,
  source_url    TEXT,
  UNIQUE (source, source_event_id)
);

CREATE INDEX idx_tournaments_format_date ON tournaments (format, event_date DESC);

CREATE TABLE archetypes (
  id                BIGSERIAL PRIMARY KEY,
  format            TEXT NOT NULL,
  name              TEXT NOT NULL,        -- MTGOFormatData由来の英語名（例: "Scam"）
  name_ja           TEXT,                 -- 表示用の日本語名（人力で用意する想定）
  definition_source TEXT NOT NULL,        -- 'rule' | 'fallback'
  UNIQUE (format, name)
);

-- フォーマット単位の設定（集計期間のデフォルト値、注記文など）。
-- 例: 統率者戦は「大会参加者中心のデータのため、カジュアルな実態より
-- 高額寄りに出る傾向があります」という注記を出す。
CREATE TABLE format_settings (
  format             TEXT PRIMARY KEY,
  default_period_days INT NOT NULL DEFAULT 30,  -- スタンダードのみ14を想定
  caveat_note        TEXT                        -- ランキングページ上部に表示する注記（なければNULL）
);

INSERT INTO format_settings (format, default_period_days, caveat_note) VALUES
  ('Standard', 14, NULL),
  ('Pioneer', 30, NULL),
  ('Modern', 30, NULL),
  ('Legacy', 30, NULL),
  ('Vintage', 30, '母数が少なく、少数の超高額カードの有無で平均・中央値が大きく振れます。参考程度にご覧ください。'),
  ('Commander', 30, '大会参加者のデッキが中心のため、カジュアルな実態より高額寄りに出る傾向があります。100枚シングルトン構成のため、同じアーキタイプでも価格のばらつきが大きくなりやすい点にもご注意ください。');

CREATE TABLE decks (
  id             BIGSERIAL PRIMARY KEY,
  tournament_id  BIGINT NOT NULL REFERENCES tournaments (id),
  player_name    TEXT,
  standing       TEXT,                    -- '5-0', '優勝', '3-1' 等、出典表記のまま保存
  archetype_id   BIGINT REFERENCES archetypes (id),  -- 未分類の場合はNULL
  total_price_jpy_est NUMERIC(12, 2),      -- 取り込み時点の参考価格（鮮度あり、ランキング集計には使わない。詳細ページの「取込当時の価格」表示用）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decks_tournament ON decks (tournament_id);
CREATE INDEX idx_decks_archetype ON decks (archetype_id);

CREATE TABLE deck_cards (
  id        BIGSERIAL PRIMARY KEY,
  deck_id   BIGINT NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
  -- 取得元の表記そのまま。oracle_id解決前（名寄せ待ち）の一時データとしてのみ使う。
  -- oracle_id解決後はscripts/import-deck-cards.mjsがNULLに戻す（card_oracles.nameと
  -- 完全に重複する値を全行分持つと容量を無駄に食う。実際にDB容量超過対応で発覚した。
  -- 読み取り側はcard_name ?? card_oracles.nameで表示する）。
  card_name TEXT,
  oracle_id UUID REFERENCES card_oracles (oracle_id), -- 名寄せ失敗時はNULL許容
  board     TEXT NOT NULL CHECK (board IN ('main', 'side')),
  quantity  INT NOT NULL
);

CREATE INDEX idx_deck_cards_deck ON deck_cards (deck_id);
CREATE INDEX idx_deck_cards_oracle ON deck_cards (oracle_id);
-- card_usage_counts_by_format RPC（使用デッキ欄）がoracle_id指定でdeck_idだけ読む集計クエリを
-- 投げるため、deck_idを含めたカバリングインデックスにしてheap fetchを避ける
-- （採用数の多いカードだとplain idx_deck_cards_oracleだけではヒープアクセスがボトルネックになり、
-- ディスクI/Oがコールドだとanonロールのstatement_timeout(3秒)を超えることがあった）。
CREATE INDEX idx_deck_cards_oracle_deck ON deck_cards (oracle_id) INCLUDE (deck_id);
-- scripts/import-deck-cards.mjsが未解決分を"oracle_id IS NULL"でフィルタしつつ"ORDER BY id"で
-- ページングする（並び順不安定によるデータ欠落を防ぐため）。deck_cardsが91万行を超えた頃から
-- この2条件の組み合わせに対応するインデックスが無く、実質全表スキャンになってタイムアウトする
-- ようになった（実際に日次パイプラインが失敗した）。部分インデックスで両方を1本にまとめる。
CREATE INDEX idx_deck_cards_unresolved_id ON deck_cards (id) WHERE oracle_id IS NULL;

-- ════════════════════════════════════════════
-- 4. 採用率・ランキング用の集計テーブル
-- ════════════════════════════════════════════

-- アーキタイプ単位の「平均デッキ価格」（直近N件の中央値ベース）
-- デッキ単位のランキングページで使用。単純平均は外れ値(1枚だけ高額カードを積んだ構成等)に
-- 弱いため中央値を採用する。
CREATE TABLE archetype_price_stats (
  id                BIGSERIAL PRIMARY KEY,
  archetype_id      BIGINT NOT NULL REFERENCES archetypes (id),
  period_deck_count INT NOT NULL,        -- 集計対象にしたデッキ件数（例: 直近20件）
  median_price_jpy  NUMERIC(12, 2) NOT NULL,
  sample_size       INT NOT NULL,        -- 実際に集計に使えた件数（20件に満たない場合もある）
  calculated_at     DATE NOT NULL,
  UNIQUE (archetype_id, calculated_at)
);

CREATE INDEX idx_archetype_price_lookup ON archetype_price_stats (calculated_at, median_price_jpy DESC);

-- 集計クエリの例（scripts/compute-deck-stats.mjsのJS実装が実際に行っている計算）:
-- 重要: total_price_jpy_est（取り込み時点の固定値）をそのまま集計に使うと、
-- 古いデッキほど当時の価格のまま計算され、実勢と乖離する（鮮度問題）。
-- 必ずdeck_cards × 当日のcard_cheapest_price_snapshots（全プリント横断の最安値）で再計算すること。
--
-- WITH deck_totals_today AS (
--   SELECT
--     d.id AS deck_id, d.archetype_id,
--     SUM(dc.quantity * ccps.jpy_est) AS total_today,
--     ROW_NUMBER() OVER (PARTITION BY d.archetype_id ORDER BY d.created_at DESC) AS rn
--   FROM decks d
--   JOIN deck_cards dc ON dc.deck_id = d.id
--   JOIN card_cheapest_price_snapshots ccps
--     ON ccps.oracle_id = dc.oracle_id AND ccps.date = CURRENT_DATE
--   WHERE d.archetype_id IS NOT NULL
--   GROUP BY d.id, d.archetype_id, d.created_at
-- )
-- INSERT INTO archetype_price_stats (archetype_id, period_deck_count, median_price_jpy, sample_size, calculated_at)
-- SELECT archetype_id, 20, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_today), COUNT(*), CURRENT_DATE
-- FROM deck_totals_today WHERE rn <= 20 GROUP BY archetype_id;

-- フォーマット別・カード別の採用率（バッチで日次再計算してキャッシュ）
CREATE TABLE card_usage_stats (
  id              BIGSERIAL PRIMARY KEY,
  format          TEXT NOT NULL,
  oracle_id       UUID NOT NULL REFERENCES card_oracles (oracle_id),
  period_days     INT NOT NULL,        -- 14 or 30（フォーマットごとのデフォルト集計期間）
  usage_rate      NUMERIC(5, 2) NOT NULL,  -- 0.00〜100.00(%)
  deck_sample_size INT NOT NULL,        -- 集計対象デッキ数（サンプル数の信頼性判断用）
  calculated_at   DATE NOT NULL,
  UNIQUE (format, oracle_id, period_days, calculated_at)
);

CREATE INDEX idx_usage_stats_lookup ON card_usage_stats (format, calculated_at, usage_rate DESC);

-- 注目カードランキング用のスコア（3日変化ベース、日次計算）
-- 取引量は無料データソースが存在しないため（2章参照）、launchでは価格・採用率の2カテゴリのみ運用する。
-- volume_change_3d_pctはTCGplayer等の有料APIを導入する将来のために列だけ用意してあり、
-- それまでは常にNULL、categoryにも'volume'は出現しない。
CREATE TABLE trending_scores (
  id                  BIGSERIAL PRIMARY KEY,
  oracle_id           UUID NOT NULL REFERENCES card_oracles (oracle_id),
  format              TEXT NOT NULL,
  calculated_date     DATE NOT NULL,
  price_change_3d_pct NUMERIC(6, 2),
  usage_change_3d_pt  NUMERIC(6, 2),
  volume_change_3d_pct NUMERIC(6, 2),  -- 将来の有料API連携まで常にNULL
  category            TEXT NOT NULL,     -- 現状は 'price' | 'usage' のみ（'volume'は将来の有料API導入後）
  score               NUMERIC(6, 2) NOT NULL,
  streak_days         INT NOT NULL DEFAULT 1,  -- 連続で同カテゴリ1位を維持している日数
  UNIQUE (oracle_id, format, calculated_date, category)
);

-- 「継続注目カード」（トップページ、src/lib/dbTrendingCards.ts）専用。trending_scores（1日あたり
-- 上位10件しか保存しない、直近3日変化ベース）とは別物で、こちらはカード詳細ページのグラフと
-- 同じ生データ（card_cheapest_price_snapshots・card_usage_stats）を全カード対象に毎日走査し、
-- 「前日比で実際に何日連続で上がり続けているか」を正確に計算して保存する
-- （scripts/compute-card-streaks.mjs）。streak_days=0（今日は上がっていない）の行は保存しない。
-- 価格はフォーマット非依存（card_cheapest_price_snapshotsがそもそもフォーマット横断の最安値）
-- なのでformatは常に'ALL'固定、採用率はフォーマットごとに別値なのでformatに実際のフォーマット名が入る。
CREATE TABLE card_streaks (
  oracle_id       UUID NOT NULL REFERENCES card_oracles (oracle_id),
  category        TEXT NOT NULL,     -- 'price' | 'usage'
  format          TEXT NOT NULL,     -- price行は常に'ALL'、usage行は実際のフォーマット名
  calculated_date DATE NOT NULL,
  streak_days     INT NOT NULL,      -- 当日を含め何日連続で前日比プラスが続いているか（>=1のみ保存）
  -- streak開始直前の値→当日の値の累積変化量。priceは%、usageはpt（採用率の単位に合わせる。
  -- どちらも「率のパーセント」ではなく実際の単位そのままなので同着比較にそのまま使える）
  change_value    NUMERIC(8, 2) NOT NULL,
  -- streak開始直前（baseline）の生の値。前日分のこの列を読んで当日分に引き継ぐことで、
  -- 「直近N日分を毎回スキャンして配列の隣接要素同士を比較する」方式（過去に採用していたが、
  -- 日付が1日でも欠けると隣接比較がずれて誤集計になる・データソースの品質が過去に遡って
  -- 変わると再集計するまで古い値を引きずる、という弱点があった）をやめ、
  -- compute-trending-scores.mjsと同じ「前日比プラスなら+1日・そうでなければリセット」の
  -- 前日引き継ぎ方式に統一するために追加した（scripts/compute-card-streaks.mjs参照）。
  baseline_value  NUMERIC(12, 2),
  PRIMARY KEY (oracle_id, category, format, calculated_date)
);

CREATE INDEX idx_card_streaks_lookup ON card_streaks (category, calculated_date, streak_days DESC);

CREATE INDEX idx_trending_lookup ON trending_scores (format, calculated_date, category, score DESC);

-- 注目カードランキング（ML価格予測）用。ml/predict_and_publish.pyが日次で全件入れ替える
-- （direction='up'/'down'それぞれTop100）。このテーブルはこのファイルに反映されておらず、
-- 2026-08-20の新規プロジェクト移行時にサイトがメンテナンス表示になる原因になっていた
-- （db/schema.sqlに書いていなかったので新規プロジェクトに作られなかった）。
-- 2026-08-21、of的中率を複数日・複数サンプルで事後検証できるように、日付ごとの予測を
-- 上書きせず残す設計に変更した（PRIMARY KEYにcalculated_atを追加）。それまでは最新1回分
-- だけを保持しており、「あの日は何を予測していたか」を遡って検証できなかった。
-- 増加量はTop100×2方向=200行/日程度でごく軽微なため、当面は間引かず全保持する
-- （将来的にDB容量を圧迫するようなら90日等で間引くことを検討、ml/predict_and_publish.py参照）。
CREATE TABLE card_price_predictions (
  oracle_id       UUID NOT NULL REFERENCES card_oracles (oracle_id),
  direction       TEXT NOT NULL,  -- 'up' | 'down'
  rank            INT NOT NULL,
  p_5             NUMERIC(5, 4) NOT NULL,
  p_10            NUMERIC(5, 4) NOT NULL,
  p_15            NUMERIC(5, 4) NOT NULL,
  p_20            NUMERIC(5, 4) NOT NULL,
  jpy_est         NUMERIC(12, 2) NOT NULL,
  calculated_at   DATE NOT NULL,
  PRIMARY KEY (oracle_id, direction, calculated_at)
);

CREATE INDEX idx_card_price_predictions_direction_rank
  ON card_price_predictions (direction, calculated_at, rank);


-- ════════════════════════════════════════════
-- 5. パックEV計算用
-- ════════════════════════════════════════════

-- Play Boosterのスロット構成（セットごとに大枠は共通だが、念のためセット単位で持つ）。
--
-- 【設計修正の経緯】当初 rarity_pool TEXT[] + probability 1個 + UNIQUE(set_code, product_type, slot_name)
-- という設計だったが、これだと1スロットにつき1行しか持てず、「ワイルドカード枠でコモン15%・
-- アンコモン64%・レア18%・神話3%」のようにスロット内で複数レアリティが異なる確率を持つ実データ
-- （src/lib/samplePackData.ts、MTGJSONの排出ウェイトテーブルから算出）を表現できないことが判明。
-- rarity_pool（配列）をrarity（単一値）に変更し、1スロット×1レアリティ＝1行にした。
CREATE TABLE pack_slot_definitions (
  id           BIGSERIAL PRIMARY KEY,
  set_code     TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT 'play_booster',
  slot_name    TEXT NOT NULL,        -- '確定コモン' | 'ワイルドカード（非フォイル）' 等
  rarity       TEXT NOT NULL,        -- 'common' | 'uncommon' | 'rare' | 'mythic'
  probability  NUMERIC(6, 4) NOT NULL, -- そのスロットでこのレアリティが出る確率（同一slot_name内の合計が1.0）
  card_count   INT NOT NULL DEFAULT 1,
  UNIQUE (set_code, product_type, slot_name, rarity)
);

-- ブースターシートのカード構成（MTGJSON booster.sheets由来、scripts/import-pack-slot-cards.mjsで
-- 一度だけ投入）。1枚1行、そのシート内での相対ウェイトを持つ。セットの印刷構成はリリース後
-- 基本的に変わらないため、pack_slot_definitions（確率）と同じく手動更新でよい
-- （新セット追加時のみ再実行）。日次で変わるのは「価格」だけなので、価格計算は
-- pack_slot_avg_prices（下記）で別に日次計算する。
CREATE TABLE pack_slot_cards (
  set_code     TEXT NOT NULL,
  product_type TEXT NOT NULL,
  slot_name    TEXT NOT NULL,
  scryfall_id  UUID NOT NULL,
  -- MTGJSONのシート内ウェイトは巨大な値になることがあり、桁数を予測しづらいため
  -- 精度固定のNUMERICではなく浮動小数点にする（相対比率としてしか使わないので厳密な精度は不要）
  weight       DOUBLE PRECISION NOT NULL,
  foil         BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (set_code, product_type, slot_name, scryfall_id)
);

CREATE INDEX idx_pack_slot_cards_lookup ON pack_slot_cards (set_code, product_type, slot_name);

-- スロット単位の期待価格（日次バッチ scripts/compute-pack-slot-avg-prices.mjs で計算）。
-- pack_slot_cards（カード構成・ウェイト）× card_print_prices（全プリントの日次価格履歴）を
-- 突き合わせ、元のsamplePackData.ts（scripts/generate-pack-data.mjs）と同じ「カード単位の
-- 出現ウェイト付き平均」を毎日計算し直す。構成は静的、価格だけ日次追従という設計。
CREATE TABLE pack_slot_avg_prices (
  set_code       TEXT NOT NULL,
  product_type   TEXT NOT NULL,
  slot_name      TEXT NOT NULL,
  avg_price_jpy  NUMERIC(10, 2) NOT NULL,
  match_rate     NUMERIC(5, 4) NOT NULL, -- ウェイト合計のうち、価格が取得できたカードの割合
  calculated_at  DATE NOT NULL,
  PRIMARY KEY (set_code, product_type, slot_name, calculated_at)
);

CREATE INDEX idx_pack_slot_avg_prices_lookup ON pack_slot_avg_prices (set_code, product_type, calculated_at);

-- パック単品の商品画像URL（TCGCSVから取得、めったに変わらないので価格と別テーブルにして
-- 日次上書きの対象から外す）。
CREATE TABLE pack_products (
  set_code       TEXT NOT NULL,
  product_type   TEXT NOT NULL,
  pack_image_url TEXT,
  PRIMARY KEY (set_code, product_type)
);


-- ════════════════════════════════════════════
-- 7. アカウント機能（お気に入り・価格アラート）
-- ════════════════════════════════════════════

-- 認証自体はSupabase Authに任せる想定（auth.usersテーブルは自動生成される）。
-- ここではauth.users.idを参照する形でアプリ固有のデータだけを持つ。
-- ローカル検証用に、Supabase Auth相当の簡易usersテーブルを用意する。
CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- お気に入りカード（無料機能。閲覧履歴的に使う）
CREATE TABLE favorite_cards (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  oracle_id  UUID NOT NULL REFERENCES card_oracles (oracle_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, oracle_id)
);

-- 価格アラート（将来のプレミアム機能候補。Fan Content Policyの
-- 「基本データは無料公開必須」に抵触しないよう、閲覧そのものではなく
-- 「通知」という付加機能として位置づける）
CREATE TABLE price_alerts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  oracle_id      UUID NOT NULL REFERENCES card_oracles (oracle_id),
  direction      TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  threshold_jpy  NUMERIC(12, 2) NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_at   TIMESTAMPTZ
);

CREATE INDEX idx_favorite_cards_user ON favorite_cards (user_id);
CREATE INDEX idx_price_alerts_active ON price_alerts (oracle_id) WHERE is_active = true;

-- RLS（Row Level Security）: 個人データは本人しか読み書きできないよう制限する。
-- auth.uid()はSupabaseが自動提供する関数（ローカル検証時は自前でスタブが必要）。
ALTER TABLE favorite_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own favorites only" ON favorite_cards
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE price_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alerts only" ON price_alerts
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ════════════════════════════════════════════
-- 8. データ保持ポリシー（肥大化対策）
-- ════════════════════════════════════════════
--
-- ここには元々card_price_snapshots（代表プリント単体の日次価格）向けの日次→週次→月次
-- ロールアップ計画があったが、getPriceHistoryForCard/getLatestPriceSnapshotの参照元を
-- card_cheapest_price_snapshots（全プリント横断の最安値）に置き換えた後、card_price_snapshots
-- 自体がどのページ・APIからも読まれない未使用テーブルになっていた（ロールアップも一度も
-- 実装・自動化されないまま）。DB容量超過（無料枠500MB）の主要因の一つだったため、
-- テーブルごと削除した。全件のバックアップはDB外（JSONL、ユーザーに提供済み）に退避してある。
--
-- 【対策3: 集計・ランキング系テーブルは「現在の状態」中心なので短期で間引く】
-- card_usage_stats / trending_scores はランキング表示用の最新値が主目的で、
-- trending_scores.streak_days は「前日分のstreak_daysを見て+1する」形で日次バッチ内に閉じて
-- 計算できるため、長期の履歴を持つ必要がない。archetype_price_stats も同様に短期のみ保持する。
--
-- DELETE FROM card_usage_stats WHERE calculated_at < CURRENT_DATE - INTERVAL '30 days';
-- DELETE FROM trending_scores WHERE calculated_date < CURRENT_DATE - INTERVAL '30 days';
-- DELETE FROM archetype_price_stats WHERE calculated_at < CURRENT_DATE - INTERVAL '90 days';
--
-- 【対象外】
-- ・sealed_price_snapshots（set_code × product_type単位、数百〜1,500件/日程度）は母数が小さく
--   無期限保持でも年間数十万行規模に収まるため、当面ロールアップ不要。
-- ・language_premium_stats も対象カードが限定的（JP独自USD価格を持つカードのみ）で同様に対象外。
--
-- 【運用への組み込み】
-- 上記の削除・ロールアップは、まだ未確定のスクレイピング/集計バッチのスケジュール
-- （日次実行タイミング自体が保留中）が決まり次第、日次バッチの最後のステップとして組み込む。
-- 週次ロールアップ（対策2）だけは日次バッチとは別に週1回のジョブとして分離してよい。


-- ════════════════════════════════════════════
-- 6. 運用メモ
-- ════════════════════════════════════════════

-- ・deck_cards.oracle_id の名寄せ（カード名 → oracle_id）は取り込みバッチ側の責務。
--   MTGO/TopDeck側の表記ゆれ（アポストロフィ違い等）を吸収する正規化関数を別途用意する想定。
-- ・price_snapshots系のデータ保持ポリシー（対象プリントの絞り込み・週次ロールアップ・
--   集計テーブルの間引き）は8章を参照。
-- ・archetypes.name_ja は自動翻訳ではなく人力でメンテナンスする前提
--   （英語のアーキタイプ名をそのまま日本語直訳すると不自然になるケースが多いため）。
-- ・get_database_size_bytes()（SECURITY DEFINER関数）は、Supabase無料枠（500MB）の
--   容量超過にscripts/check-db-size.mjs（日次パイプライン最後のステップ）が気づけるよう、
--   pg_database_size()をPostgREST経由（RPC）で呼べるようにするためのラッパー。
--   pg_database_size()自体はテーブルAPIから直接呼べないため必要。
CREATE OR REPLACE FUNCTION public.get_database_size_bytes()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_database_size(current_database());
$$;

GRANT EXECUTE ON FUNCTION public.get_database_size_bytes() TO anon, authenticated;

-- カード詳細ページ「使用デッキ」欄（src/lib/dbCardUsageByFormat.ts）が使うRPC。
-- 以前はdeck_cards→decks→tournamentsの埋め込みJOINで該当行を丸ごとページング取得し
-- JS側で集計していたが、採用数の多いカードだと数千〜1万行規模の逐次ページングが発生し
-- 表示が数秒〜十数秒かかっていた。フォーマット×期間（current/prev）ごとの件数だけを
-- Postgres側で集計して返すことで、転送行数を数万行から数行に削減する。
CREATE OR REPLACE FUNCTION public.card_usage_counts_by_format(p_oracle_id uuid, p_period_days int)
RETURNS TABLE(format text, window_key text, deck_count bigint)
LANGUAGE sql STABLE AS $$
  SELECT
    t.format,
    CASE WHEN t.event_date >= (current_date - (p_period_days - 1)) THEN 'current' ELSE 'prev' END AS window_key,
    COUNT(DISTINCT dc.deck_id) AS deck_count
  FROM deck_cards dc
  JOIN decks d ON d.id = dc.deck_id
  JOIN tournaments t ON t.id = d.tournament_id
  WHERE dc.oracle_id = p_oracle_id
    AND t.event_date >= (current_date - (2 * p_period_days - 1))
    AND t.event_date <= current_date
  GROUP BY t.format, window_key;
$$;

-- mana_value_from_cost関数はファイル冒頭（cards生成列より前）に移動済み。
