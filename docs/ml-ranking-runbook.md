# 注目カードランキング（高騰予想）手動実行手順

`ml/predict_and_publish.py`は自動実行しない（過去に自動化して失敗しまくったため手動に戻した経緯、
docs/incident-log.md参照）。毎回Claude Codeに依頼して手動実行する運用のため、実行者（Claude）が
毎回迷わないよう手順を固定しておく。

## 実行タイミングの目安

**金曜**を推奨（理由は`ml/predict_and_publish.py`のdocstring参照。Commanderのトーナメント結果が
土曜に集中するため、LAG_DAYS=3の除外範囲と噛み合わず、かつユーザーが週末の買い物前に見られる）。
ただし厳密な曜日固定ではなく、ユーザーから依頼があったタイミングで実行してよい。

## 事前確認（必須）

1. **docs/incident-log.md を読む**（AGENTS.mdのルール、Supabase/R2/D1関連コードを触る前提）。
2. `.env.local`に以下の環境変数が揃っているか確認する（`grep -oE '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|R2_BUCKET_NAME|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ENDPOINT_URL)=' .env.local`）:
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（D1のcatalog_oracles取得用）
   - `R2_BUCKET_NAME` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT_URL`
3. Pythonの依存関係が入っているか（`pip show lightgbm scikit-learn pandas` 等でざっと確認、
   無ければ `pip install -r ml/requirements.txt`）。

## 実行手順

必ずこの順番で、同じセッション内で続けて実行する（`fetch_data.py`を挟まず前回のキャッシュで
`predict_and_publish.py`だけ実行すると、`ensure_fresh_data()`がmtimeチェックで弾く設計。
2026-08-27に「古いデータのまま本番へ書き込んだ」事故があったための機械的ガード）。

```bash
cd ~/jp-mtgstocks
set -a; source .env.local; set +a
python ml/fetch_data.py
python ml/predict_and_publish.py
```

- `fetch_data.py`はR2の価格履歴全件（30ヶ月超）を読むため、数分〜十分程度かかる。
  `run_in_background: true`で実行し、完了を待つ。
- 途中でSupabaseの5xx等の一時的なエラーが出ても`fetch_data.py`側にリトライが入っているので
  基本的に自動で継続する（2026-09-11修正）。
- `predict_and_publish.py`はモデル学習を含むため数十秒〜数分。

## 実行後の確認

1. ログの最後に `完了。` が出ていること。
2. Supabaseで最新`calculated_at`が今日の日付になっているか確認:
   ```sql
   select calculated_at, count(*) from card_price_predictions group by 1 order by 1 desc limit 3;
   ```
   `up`/`down`各100件、計200件が最新日付で入っていれば正常。
3. 本番サイトの注目カードランキング（トップページ）が最新予測日を表示しているか、
   実際に開いて確認する（ISRキャッシュの反映に多少ラグがある場合がある）。

## 失敗時のよくある原因

- `ensure_fresh_data()`で中断 → `fetch_data.py`を先に実行し忘れている。手順通りやり直す。
- 為替レートが無くて`fetch_data.py`が失敗 → `scripts/snapshot-exchange-rates.mjs`を先に実行。
- Supabase/R2の一時的な5xx → 数分待って再実行。何度も失敗する場合はSupabase/Cloudflareの
  障害情報を確認する。
