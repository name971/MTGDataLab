# MTG DataLab

MTGカードの価格トレンド・トーナメント環境・パック期待値を可視化する日本語サイト。仕様の詳細は [`docs/spec.md`](docs/spec.md) を参照。

リポジトリ名（`jp-mtgstocks`）は初期開発コードネームの名残で、サイト名は「MTG DataLab」です。

## 技術スタック

- Next.js 16 (App Router) + TypeScript + Tailwind CSS
- Cloudflare Pages（`@opennextjs/cloudflare`アダプター経由）
- Supabase (PostgreSQL) + Supabase Auth
- 検索: PostgreSQL `pg_trgm`

## セットアップ

```bash
npm install
cp .env.local.example .env.local   # Supabaseのプロジェクト情報を記入
npm run dev
```

Cloudflareへのデプロイ確認用（ローカルでworkerとして動作確認）:

```bash
npm run preview
```

## フォルダ構成

```
docs/spec.md              全体仕様書（データソース、機能、表示ルール、収益モデル）
db/schema.sql             DBスキーマ（PostgreSQL/Supabase想定、動作検証済み）
db/search-design.sql      検索機能（pg_trgmによる日英あいまい検索）
src/app/                  画面（App Router）。各ページは仕様書6章に対応するプレースホルダー実装
src/lib/                  Supabaseクライアント・Scryfall/為替APIヘルパー・フォーマット定義
src/lib/archetypeEngine.ts  アーキタイプ判定エンジン（reference/scripts/から移植済み、テスト付き）
src/lib/nameMatching.ts     カード名の名寄せ（同上。Supabase RPC経由に置き換え済み、要db/search-design.sqlのresolve_oracle_id関数）
src/components/           Header（検索バー含む）・Footer（Fan Content Policy免責文言）
reference/scripts/        移植元の原本（履歴として保持。実装は上記src/lib/を参照）
reference/prototype/      Scryfall実APIを使った動作確認プロトタイプ（ブラウザで直接開いて動く）
```

## 実装済み（このスキャフォールドの範囲）

- Next.js + Tailwind + Cloudflare Pages（`@opennextjs/cloudflare`）の初期化
- Supabaseクライアント (`src/lib/supabase.ts`)
- Scryfall API / 為替レート取得ヘルパー (`src/lib/scryfall.ts`, `src/lib/fx.ts`)
- 主要画面のルーティングとプレースホルダー
  - `/` トップページ
  - `/cards/[oracleId]` カード詳細
  - `/rankings/[format]` フォーマット別カードランキング
  - `/decks` デッキ（アーキタイプ）ランキング
  - `/decks/[deckId]` デッキ詳細
  - `/packs` パックEV計算
  - `/search` 検索結果
- Fan Content Policy免責文言（フッター常設）

## 次にやること

1. `db/schema.sql`（`resolve_oracle_id`関数を含む`db/search-design.sql`も）をSupabaseに適用し、`.env.local`にプロジェクト情報を設定
2. 各ページのプレースホルダー/サンプルデータを実データ（Supabase + Scryfall + Frankfurter API）で置き換える
3. `docs/spec.md` 7章の表示ルール（強調色・価格の丸め方・画像表示の有無）を各画面に反映
4. お気に入り・価格アラート等のアカウント機能をSupabase Authと連携

## 決まっている表示ルール（spec.mdより抜粋、実装時に必ず守る）

- カード名: 日本語名があればメイン表示、なければ英語名をそのままメイン表示（フォールバック時に不自然な余白を作らない）
- 画像: カード詳細ページ・ランキング一覧・デッキ詳細の画像タブは表示、デッキ詳細のリストタブは非表示
- 価格: 円建て、為替換算の参考値である旨を明記、キリのいい数字に丸めない
- 強調色: 最高値=赤背景、最安値=青背景で統一
- スタンダードのみ集計期間14日（他フォーマットは30日）
- Fan Content Policy免責文言をフッターに常設（spec.md 9章に文言あり）

## 未着手・保留事項

`docs/spec.md` の最終セクション参照。
