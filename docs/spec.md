# 日本語版MTGStocks 仕様書

## 1. プロジェクト概要

MTGStocks（mtgstocks.com）の日本語版として、MTGカードの価格トレンド・トーナメント環境・パック期待値を可視化するサイト。無料公開＋広告収益をベースに、将来的にTCGplayerアフィリエイトと組み合わせる。

---

## 2. データソース

### 採用したもの

| ソース | 用途 | 規約上の位置づけ |
|---|---|---|
| Scryfall API | カードマスタ・USD/EUR価格・画像 | 利用規約の範囲内。画像は直リンク（自前ホスト不要）。日次バッチでの全件取得は個別カードAPI（`/cards/named`等）ではなく[Bulk Data](https://scryfall.com/docs/api/bulk-data)（1日1回更新の全カードJSON）を使う。個別API呼び出しはレート制限（推奨10req/s）があり、追跡対象4〜5万件を毎日回すには非現実的なため。カード詳細ページ等の単発ルックアップ（`src/lib/scryfall.ts`）は個別APIのままでよい |
| mtgo.com（公式デッキリスト） | トーナメント結果・デッキリスト | Wizards Fan Content Policy準拠（無料公開・非公式表記・広告収益OK） |
| TopDeck.gg API | トーナメント結果（LGS含む） | 公式API・無料・要クレジット表示 |
| TCGCSV | シールド商品（パック）価格 | 運営者が明示的にスクレイピング許可 |
| MTGJSON | パックEV計算用のPlay Booster排出率（`data.booster.play.sheets`の各カードweight値をレアリティ別に集計して算出。手順は`src/lib/samplePackData.ts`のコメント参照） | オープンソース・無料。WotC公式のCollecting記事を毎回手動で読むより効率的で、全セット共通の手順で機械的に算出できる |
| Frankfurter API | 為替レート（USD/EUR→JPY） | APIキー不要・レート制限なし |
| Badaro/MTGOFormatData | アーキタイプ判定ルール（JSON） | ライセンス不明だが確認不要と判断 |
| j6e/mtg-meta-analyzer | 判定ロジックの参考実装 | MITライセンス |

### 検討したが不採用

- **Wisdom Guild**：集約サイトの再集約になり差別化しにくい、依存リスク
- **晴れる屋・遊々亭・カードラッシュ**：スクレイピング/再配布が規約上NG
- **MTGGoldfish**：規約が非商用限定
- **Melee.gg**：ログイン認証を使った自動化はアカウントBANリスクが高い
- **eBay**：Marketplace Insights APIが承認パートナー限定
- **TCGplayer取引量データ**：無料では取得不可（有料APIのみ）

### 取引量データについて

無料ソースが存在しないため、launchでは**価格・採用率の2軸のみ**で運用。TCGplayerアフィリエイトが軌道に乗ったらTCGAPIs.com等の有料APIを検討する（優先度の高い将来拡張）。

### 対外的な確認作業

fbettega氏・j6e氏・MTGOFormatDataメンテナー（Jiliac氏）への利用許諾確認は**いずれも不要と判断**。TCGplayerアフィリエイト申請は**サイトが軌道に乗ってから**。

---

## 3. 技術スタック

- **フロントエンド**：Next.js + Cloudflare Pages（`@opennextjs/cloudflare`アダプター経由）
- **画像**：Scryfall直リンク（自前ホストしない。将来的に表示速度が問題になればCloudflare Cache Rulesで edge キャッシュを追加検討）
- **DB**：Supabase（PostgreSQL）
- **認証**：Supabase Auth（`auth.uid()` + RLSで個人データを保護）
- **検索**：PostgreSQL `pg_trgm`（日英混在あいまい検索）

---

## 4. データベーススキーマ・データ基盤

`schema.sql`（Supabase/Postgres）・`db/archive-schema.sql`（Cloudflare D1、後述の通り現在はカタログ用途のみ）として別途納品済み。

**2026-08時点で、当初計画（Postgres一本＋週次/月次ロールアップ）から実装が大きく変わっている。** Postgresの無料枠（500MB）が価格の全履歴を持つには小さすぎることが運用開始後に判明し、「今の状態」はPostgres、「時系列の全履歴」はCloudflare R2、という3層構成に再設計した。詳細な経緯は本章末尾を参照。

### 現在のストレージ構成（3層）

| ストレージ | 役割 | 具体例 |
|---|---|---|
| **Supabase (Postgres)** | 頻繁に読む「今の状態」。行数が増えないキャッシュ型のテーブルのみ置く | `card_current_prices`・`card_print_current_prices`（1行=1カード/プリントの現在価格）、`card_usage_stats`（採用率、60日で自動削除）、`decks`・`deck_cards`・`tournaments`・`archetypes`など |
| **Cloudflare D1** | デッキで一度も使われていないカードのカタログ検索専用 | `catalog_oracles`・`catalog_prints`（`card_oracles`/`card_prints`の未収録分。名前・画像・価格の直近値を持つ） |
| **Cloudflare R2** | 全カードの価格時系列の全履歴（2024-02〜、無期限） | カード単位ファイル1枚=1カードの価格推移（`oracle-history/{oracle_id}.ndjson.gz`・`print-history/{scryfall_id}.ndjson.gz`）。月次バルクファイルはバッチ集計専用 |

Postgresのテーブル構成自体（`card_oracles`/`card_prints`/`sets`/`tournaments`/`archetypes`/`decks`/`deck_cards`/`card_usage_stats`/`trending_scores`/`card_streaks`/`pack_slot_*`/`users`/`favorite_cards`/`price_alerts`等）は当初計画とおおむね一致している。変わったのは**価格の時系列データの置き場所**のみ。

### データ保持ポリシー

- **Postgresは「今の価格」の1行キャッシュのみ**：`card_current_prices`（オラクル単位）・`card_print_current_prices`（プリント単位）は日次で上書きするだけなので、日数が経っても行数が増えない
- **時系列の全履歴はR2で無期限保持**：日次バッチが当日分をR2のカード単位ファイルへ追記していく。行数でなくリクエスト回数で課金されるため、全カード×2024-02〜の履歴を無期限に持っても無料枠（storage 10GB、書き込み100万リクエスト/月、読み取り1,000万リクエスト/月）に収まる
- **集計テーブルは短期のみ保持**：`card_usage_stats`は60日、`trending_scores`は前日比分のみで自動削除
- **旧設計の名残（廃止済み・間引き中）**：`card_print_prices`（プリント単位JSONB全履歴）・`card_cheapest_price_snapshots`（オラクル単位の日次スナップショット）は新規書き込みを停止済み。前者は既存データをR2へ吸い出しながら間引いており（`scripts/archive-old-print-prices.mjs`）、完了後はテーブルごと削除してよい。後者は既に空

### 設計上の重要な判断

- **oracle_id単位とscryfall_id単位を明確に分離**：同一カードの複数プリントを束ねるため
- **価格履歴はoracle_id単位で「その日の全プリント中最安値」を記録し、scryfall_idは監査用カラム**：オラクル単位の価格系列は、当初計画の「en/ja seriesごとに記録」ではなく「その日どのプリントが最安だったか」をscryfall_id列に持つ形に変わった。再録で最安プリントが入れ替わっても同じオラクルの系列として価格チャートの履歴が連続する
- **デッキ未使用カードもカタログとして持つ**：当初計画には無かった要件。デッキで一度も使われていないカードも検索・詳細ページの対象にするため、Postgres未収録分をD1に別途持たせている
- **デッキ価格の鮮度問題**：ランキング集計は`deck_cards`×当日の現在価格キャッシュで毎回再計算する
- **価格nullのフォールバック**：低流動性カード（Reserved List等）で価格がnullになった場合、直近の非null値を繰り越す
- **日本語名の更新ルール**：`card_oracles.printed_name_ja`は「日本語版プリントのうち発売日が最新のもの」を採用（エラッタ改名対応）

### 経緯（なぜPostgres一本から3層構成に変わったか）

1. 当初計画通りPostgresに日次価格履歴（JSONB）を書き続けた結果、無料枠500MBを圧迫。「今の価格」1行キャッシュ＋日次履歴は別ストレージ、という形に再設計
2. 日次履歴の移設先に最初はCloudflare D1を選んだが、D1無料枠の**日次リクエスト数上限**（読み取り500万行/日・書き込み10万行/日）に達し、ランキング/価格推移グラフ表示のたびにこの上限を超過する事態に
3. リクエスト回数課金のCloudflare R2へ全面移行。ただし保存形式（月次バルクファイルを毎回全部読む設計）がCloudflare Workers無料枠のCPU時間制限（10ms/リクエスト）に抵触するリスクがあったため、1カード=1ファイルの単位に再設計して決着

---

## 5. 判定エンジン（アーキタイプ分類）

TypeScriptで自前実装。`archetype-engine.ts`として納品済み。Badaro/MTGOFormatDataのルール形式（`InMainboard`/`OneOrMoreInMainboard`/`TwoOrMoreInMainboard`等のAND条件、Variants、Fallback）をそのまま解釈する軽量な判定ロジック。

- 実際のMTGOFormatData（Modern、130アーキタイプ）を読み込んで動作検証済み
- ルールは配列の先頭から順に評価し、最初にマッチしたものを採用
- どの定義にもマッチしない場合はFallback定義との共通カード数で近似分類、それも閾値未満なら「未分類」

### カード名の名寄せ

`name-matching.ts`として納品済み。正規化（大文字小文字・空白・アクセント記号・分割カードのスラッシュ表記）→完全一致→トライグラムあいまい一致（閾値0.6）→未マッチ、の3段階。

---

## 6. 主要機能・画面

### トップページ
検索バー → 注目カード（カテゴリごとの1位を常時表示、閾値による足切りなし、連続日数バッジ付き）→ 注目カードランキング（価格・採用率の3日変化を合成したスコア順。取引量は2章の通りlaunchでは対象外）→ フォーマットランキング（タブ切替、集計期間連動表示）

### カード詳細ページ
日本語名メイン表示（なければ英語名にフォールバック）、円建て価格推移チャート（期間切替、JP/EN比較トグル、為替換算の参考値である旨を明記、丸めない）

### フォーマット別カードランキング
値上がり率/値下がり率でソート（取引量は2章の通りlaunchでは対象外）。スタンダードのみ集計期間14日（他30日）。最高値=赤背景、最安値=青背景で強調。スタンダードのみテーブルトップ/Arena価格を並列表示。

### デッキ単位のランキング（アーキタイプランキング）
採用率順/平均価格順（直近20件の中央値）。フォーマット別に`format_settings.caveat_note`があれば注記を表示（統率者戦・ヴィンテージ等）。

### デッキ詳細ページ
リストタブ（画像なし、単価×枚数表記）／画像タブ（カードアートのグリッド表示）の切替。

### パックEV計算ページ
Play Boosterのみ対応（Collector Boosterは構成が複雑すぎるため見送り）。WotC公式排出率 × Scryfall/TCGCSV価格。

### 検索
`pg_trgm`による日英混在あいまい検索。2〜3文字未満はクエリを発火させない。

### アカウント機能
お気に入りカード、価格アラート。Fan Content Policyの「基本データは無料公開必須」を侵さないよう、閲覧自体は非ログインでも可能。

---

## 7. 表示ルール

### カード名
日本語名があればメイン表示、英語名は補助（一覧では省略）。日本語名がなければ英語名をそのままメイン表示（フォールバック時に不自然な余白ができないよう行構成を統一）。

### 画像

| 画面 | 画像 |
|---|---|
| カード詳細ページ | あり（`normal`サイズ） |
| 値上がり/フォーマット/注目カード ランキング | あり（サムネイルサイズで判別可能） |
| デッキ詳細ページ「画像」タブ | あり（グリッド） |
| デッキ詳細ページ「リスト」タブ | なし |

### 価格表示
円建て、為替換算の参考値であることを明記。キリのいい数字に丸めない（計算値であることの誠実さを優先）。

### 強調色
最高値=赤背景、最安値=青背景で統一。

---

## 8. 収益モデル

1. **広告**（無料公開が条件、Fan Content Policy準拠）
2. **TCGplayerアフィリエイト**（Impact経由、ファーストクリック48時間、3.5%）※サイトが軌道に乗ってから申請
3. **将来のプレミアム機能候補**：価格アラート、コレクション照合、詳細グラフ、広告非表示（基本データは常に無料のまま）

---

## 9. 公開前に必要な定型文書

### Fan Content Policy免責表記（フッター常設）

```
[サイト名]は、Fan Content Policyのもとで許可された非公式のファンコンテンツです。
Wizards of the Coastによる承認・後援を受けたものではありません。
使用されている素材の一部はWizards of the Coastの所有物です。©Wizards of the Coast LLC.
```

原文（英語）：
> "[サイト名] is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC."

広告収益はFan Content Policy上OKなので、「non-commercial」を名乗る必要はない。

### プライバシーポリシー・Cookie表記

Supabase Authでメールアドレス等の個人情報を扱うため、日本の個人情報保護法の観点からプライバシーポリシーページが必要。広告配信でCookieを使うため、Cookie使用の表記も必要。GDPR（EU圏アクセスへの対応）は本格対応するかは要検討だが、最低限のプライバシーポリシーは公開前に用意する。

---

## 10. 未着手・保留事項

- モバイルの詳細ブレークポイント調整（標準的なデフォルト値を使う想定）
- Collector Booster EV
- 取引量データ（有料API検討は将来）
- 統率者戦以外のフォーマットでの注記追加（必要になった都度）
