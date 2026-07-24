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

## 4. データベーススキーマ

`schema.sql`として別途納品済み。実際にPostgreSQLに流し込み、ダミーデータでの動作検証まで完了している。

### テーブル構成

| グループ | テーブル |
|---|---|
| カードマスタ | `card_oracles`（カード概念単位）、`cards`（プリント単位） |
| 価格 | `exchange_rates`、`card_price_snapshots`、`sealed_price_snapshots`、`language_premium_stats` |
| トーナメント・デッキ | `tournaments`、`archetypes`、`decks`、`deck_cards`、`format_settings` |
| 集計・ランキング | `card_usage_stats`（採用率）、`trending_scores`（注目カードスコア）、`archetype_price_stats`（アーキタイプ中央値） |
| パックEV | `pack_slot_definitions`（Play Boosterのみ） |
| アカウント | `users`、`favorite_cards`、`price_alerts`（RLSで本人以外アクセス不可） |
| データ保持（肥大化対策） | `card_price_snapshots_weekly`（週次ロールアップ）、`card_price_snapshots_monthly`（月次ロールアップ） |

### データ保持ポリシー（肥大化対策）

全プリンティングを無期限に日次追跡すると年間3,000万〜4,000万行規模になりSupabaseの容量を圧迫するため、以下の方針で運用する（詳細は`schema.sql` 8章）。

- **価格追跡の対象を絞る**：`card_price_snapshots`は各oracle_idの代表プリントと日本語版プリント（存在する場合）のみ対象とし、ショーケース等の亜種プリントは追跡しない
- **日次→週次→月次の3段階で解像度を落とす**：価格チャートの期間切替の具体的な日数は未定だが、直近1ヶ月分の生データがあれば当面の表示要件は満たせるため、直近30日は`card_price_snapshots`に日次、30日〜365日は`card_price_snapshots_weekly`に週次、365日超は`card_price_snapshots_monthly`に月次（無期限保持）で集約する。週次だけを無期限保持すると数年で再び容量を圧迫するため、1年より古いデータはさらに月次（週次の約4分の1のペース）に丸めて増加を抑える。引き換えに1年より前の価格は月次の粒度でしか見られなくなる
- **集計テーブルは短期のみ保持**：`card_usage_stats`/`trending_scores`は30日、`archetype_price_stats`は90日で削除（いずれも「現在の状態」表示が主目的で長期履歴は不要なため）
- `sealed_price_snapshots`・`language_premium_stats`は母数が小さいため対象外（ロールアップ不要）

この削除・ロールアップ処理は、まだ未確定のスクレイピング/集計バッチのスケジュールが決まり次第、日次バッチ（週次ロールアップは週1回、月次ロールアップは月1回の別ジョブ）に組み込む。

### 設計上の重要な判断

- **oracle_id単位とscryfall_id単位を明確に分離**：同一カードの複数プリントを束ねるため
- **価格履歴はoracle_id + series（en/ja）単位で記録し、scryfall_idはキーにしない**：`card_price_snapshots`をscryfall_id（プリント単位）でキーにすると、再録で代表プリントが切り替わるたびに新しいプリントの行として履歴がゼロから始まってしまう。oracle_id + series（'en'/'ja'）を主キーにすることで、代表プリントが変わっても同じ系列として価格チャートの履歴が連続する。scryfall_idは「その日実際に価格を取得したプリントがどれだったか」の監査用カラムとして保持するのみ
- **デッキ価格の鮮度問題**：`decks.total_price_jpy_est`は取り込み時点の参考値に留め、ランキング集計は`deck_cards × 当日のcard_price_snapshots`で毎回再計算する
- **価格nullのフォールバック**：低流動性カード（Reserved List等）で価格がnullになった場合、直近の非null値を繰り越す
- **日本語名の更新ルール**：`card_oracles.printed_name_ja`は「日本語版プリントのうち発売日が最新のもの」を採用（エラッタ改名対応）
- **言語プレミアム**：新規外部データソース不要。既存のcard_price_snapshotsの'en'系列と'ja'系列を突き合わせるだけで、EN版とJP版が両方独自のUSD価格を持つカードに限り計算可能

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
