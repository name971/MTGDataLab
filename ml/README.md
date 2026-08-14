# 価格予測モデル（実験段階）

カードの1週間後の価格変動率（対数リターン）を予測するモデルの学習パイプライン。
本番サイト（Next.js/Supabase、リポジトリルート）とは完全に切り離して実行する。
学習結果・中間データはSupabaseのPostgres DB（無料枠500MB）には一切書き込まない
（`ml/data/`配下のローカルファイル/CIアーティファクトとしてのみ扱う）。

## 背景・制約

- 自前のCloudflare D1に蓄積された実価格履歴（`price_history_archive`）は
  2026-07-25以降のみで、まだ日が浅い。
- 長期履歴はTCGCSV（`tcgcsv.com`、TCGPlayer価格の非公式ミラー、2024-02-08〜の
  日次アーカイブを配布）からCloudflare R2（月次NDJSON.gz、`price-history/`・
  `print-price-history/`）へ全カード分バックフィル済み。日次更新も
  `snapshot_catalog_prices_daily.py`がGitHub Actionsから回している
  （`.github/workflows/daily-data-pipeline.yml`）。
- MTGJSON（`AllIdentifiers`）はTCGPlayerのproductId→Scryfall IDのクロスウォーク作成にのみ使用。
  価格データ自体（`AllPrices`）はもう使っていない。

## 実行手順

```bash
pip install -r ml/requirements.txt

# 1. データ取得（D1実データ + Supabase + R2長期履歴をマージし、ml/data/にキャッシュ）
NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
python ml/fetch_data.py

# 2. ベースラインモデルの学習・ウォークフォワード評価
python ml/train_baseline.py
```

## 構成

- `fetch_data.py` — Cloudflare D1（自前の実価格履歴）、Supabase（採用率・静的属性、REST経由）、
  R2（TCGCSV由来の長期履歴）を取得し、オラクル単位の日次価格系列にマージして
  `ml/data/`にキャッシュする。
- `fetch_tcgcsv_history.py` — TCGCSVの日次アーカイブを全カード分バックフィルしてR2へ
  書き込む一括実行スクリプト（既に完了済みだが、再実行や期間拡張に使う）。
- `snapshot_catalog_prices_daily.py` — 上記の日次差分版。当日（失敗時は前日）分のみ取得し
  R2の当月ファイルへ追記する。GitHub Actionsから毎日実行。
- `features.py` — 静的属性（レアリティ・タイプ・CMC）・時系列特徴量（リターン・移動平均・
  ボラティリティ）・採用率特徴量（`card_usage_stats`）を組み立てる。
- `train_baseline.py` — 単一LightGBM（`objective=quantile`）でのウォークフォワード評価。
  データ期間が短い間は窓サイズを自動的に縮める。

## 今のスコープ外（データが溜まってから）

- CatBoost/リッジ回帰/CNNによるスタッキングアンサンブル
- 分位点予測による80%予測区間・バックテスト（簡易売買シミュレーション）
- SHAP分析
- 予測結果をSupabaseの新規テーブルに書き戻してサイトに表示する機能

これらは`docs/price-prediction-plan.md`（設計メモ）を参照し、ベースラインの精度が
実用に足ると判断できてから着手する。
