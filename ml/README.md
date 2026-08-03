# 価格予測モデル（実験段階）

カードの1週間後の価格変動率（対数リターン）を予測するモデルの学習パイプライン。
本番サイト（Next.js/Supabase、リポジトリルート）とは完全に切り離して実行する。
学習結果・中間データはSupabaseのPostgres DB（無料枠500MB）には一切書き込まない
（`ml/data/`配下のローカルファイル/CIアーティファクトとしてのみ扱う）。

## 背景・制約

- 自前のSupabase DBに蓄積された実価格履歴（`card_cheapest_price_snapshots`）は
  2026-07-24以降のみで、まだ10日程度しかない。
- MTGJSON（`AllPrices`）は直近90日分のローリング履歴のみを配布しており、
  2020年〜のような数年規模の履歴は公式には存在しない。
- そのため現時点では「本格的なスタッキング＋数年規模のウォークフォワードCV」は行わず、
  90日程度のデータで動く単一LightGBMのベースラインを構築し、データが溜まるにつれて
  ウォークフォワード窓を広げていく設計にする。

## 実行手順

```bash
pip install -r ml/requirements.txt

# 1. データ取得（Supabase実データ + MTGJSON過去90日分をマージし、ml/data/にキャッシュ）
NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... python ml/fetch_data.py

# 2. ベースラインモデルの学習・ウォークフォワード評価
python ml/train_baseline.py
```

## 構成

- `fetch_data.py` — Supabase（自前の実データ、REST経由）とMTGJSON（`AllIdentifiers`/`AllPrices`、
  過去90日分の補完用）を取得し、オラクル単位の日次価格系列にマージして`ml/data/`にキャッシュする。
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
