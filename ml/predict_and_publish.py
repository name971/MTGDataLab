"""
competitiveセグメントの価格予測モデルを学習し、直近日付のTop100候補（値上がり確率の
段階表示、+5/10/15/20%以上それぞれの確率、predict_magnitude_ladder.py参照）を
Supabaseの`card_price_predictions`テーブルに書き込む。

サイト側（src/lib/dbMlRanking.ts）がこのテーブルの最新calculated_at分だけを読んで
注目カードランキングに使う。2026-08-21、的中率を複数日・複数サンプルで事後検証できる
よう、日付ごとの予測を上書きせず残す設計に変更した（PRIMARY KEYにcalculated_atを追加、
db/schema.sql参照）。それまでは最新1回分だけを保持しており、過去の予測を遡って
検証できなかった。

ランキング順位はp_5（+5%以上の確率、最も緩い閾値）を使う。SOAR_QUANTILEの
グリッドサーチ（docs/price-prediction-plan.md 12-4章）で、閾値を緩めた方が
実際のPrecision@Nが高かったことに合わせている。

2026-08-21、.github/workflows/daily-data-pipeline.ymlに組み込み、日次自動実行になった
（それまでは手動実行のみだった）。

実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
      python ml/predict_and_publish.py
"""

from __future__ import annotations

import os
from datetime import timedelta

import requests

from features import TARGET_COLUMN, build_training_frame
from predict_magnitude_ladder import THRESHOLDS_PCT, fit_calibrated_ladder, predict_ladder

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
TOP_N = 100
RANK_BY = f"p_{THRESHOLDS_PCT[0]}"  # 最も緩い閾値（+5%以上）で順位を決める
RETENTION_DAYS = 90  # 的中率検証に使う過去分の保持期間


def _require_supabase_env() -> None:
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise SystemExit("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください")


def supabase_upsert(table: str, rows: list[dict], on_conflict: str) -> None:
    if not rows:
        return
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=rows,
        timeout=60,
    )
    res.raise_for_status()


def supabase_prune_older_than(table: str, cutoff_date: str) -> None:
    # 的中率検証に使う程度の行数（Top100×2方向/日）なのでDB容量への影響は軽微だが、
    # 無期限に積み上げず一応の上限は設ける（2026-08、DB容量超過を繰り返した教訓）。
    res = requests.delete(
        f"{SUPABASE_URL}/rest/v1/{table}?calculated_at=lt.{cutoff_date}",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {SUPABASE_ANON_KEY}"},
        timeout=60,
    )
    res.raise_for_status()


def _build_rows(frame, latest_date, latest, direction: str) -> list[dict]:
    print(f"閾値ごとのキャリブレーション済みモデルを学習中（{direction}）...")
    labeled = frame.dropna(subset=[TARGET_COLUMN])
    # test_dfは内部で使わないのでダミーでlabeledを渡す
    models = fit_calibrated_ladder(labeled, labeled, direction=direction)

    ladder = predict_ladder(models, latest)
    joined = latest.join(ladder)
    # 表示は%を四捨五入するため、ソートも表示値ベースで揃える（生の値だと表示上同率でも
    # 逆順に見えることがあったため）。表示上も同率ならp_10→p_15→p_20の順に丸めた値で比較する
    sort_cols = [f"p_{x}" for x in THRESHOLDS_PCT]
    rounded = joined[sort_cols].round(2)
    top = joined.loc[rounded.sort_values(sort_cols, ascending=False).index].head(TOP_N).reset_index(drop=True)

    return [
        {
            "oracle_id": row["oracle_id"],
            "direction": direction,
            "rank": i + 1,
            "p_5": round(float(row["p_5"]), 4),
            "p_10": round(float(row["p_10"]), 4),
            "p_15": round(float(row["p_15"]), 4),
            "p_20": round(float(row["p_20"]), 4),
            "jpy_est": round(float(row["jpy_est"]), 2),
            "calculated_at": str(latest_date.date()),
        }
        for i, row in top.iterrows()
    ]


def main() -> None:
    _require_supabase_env()

    print("特徴量データフレームを構築中（competitive）...")
    frame = build_training_frame("competitive")

    latest_date = frame["date"].max()
    latest = frame[frame["date"] == latest_date].dropna(subset=["jpy_est"]).copy()
    if latest.empty:
        raise SystemExit("最新日の価格データがありません。ml/fetch_data.py を先に実行してください。")

    rows = _build_rows(frame, latest_date, latest, "up") + _build_rows(frame, latest_date, latest, "down")

    print(f"{latest_date.date()} 時点のTop{TOP_N}件×2方向をSupabaseへ書き込み中...")
    supabase_upsert("card_price_predictions", rows, on_conflict="oracle_id,direction,calculated_at")

    cutoff = (latest_date - timedelta(days=RETENTION_DAYS)).date()
    supabase_prune_older_than("card_price_predictions", str(cutoff))
    print("完了。")


if __name__ == "__main__":
    main()
