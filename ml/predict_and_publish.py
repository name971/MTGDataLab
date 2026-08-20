"""
competitiveセグメントの価格予測モデルを学習し、直近日付のTop100候補（値上がり確率の
段階表示、+5/10/15/20%以上それぞれの確率、predict_magnitude_ladder.py参照）を
Supabaseの`card_price_predictions`テーブルに書き込む。

サイト側（src/lib/dbMlRanking.ts）がこのテーブルを読んで注目カードランキングに使う。
`card_current_prices`と同じ設計思想で、最新予測だけを1オラクル1行で持つ
（時系列で溜め込まない）。実行のたびに全件入れ替える。

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

import requests

from features import TARGET_COLUMN, build_training_frame
from predict_magnitude_ladder import THRESHOLDS_PCT, fit_calibrated_ladder, predict_ladder

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
TOP_N = 100
RANK_BY = f"p_{THRESHOLDS_PCT[0]}"  # 最も緩い閾値（+5%以上）で順位を決める


def _require_supabase_env() -> None:
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise SystemExit("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください")


def supabase_delete_all(table: str) -> None:
    # PostgRESTはWHERE無しのDELETEを拒否するため、常に真になる条件を明示的に付ける
    res = requests.delete(
        f"{SUPABASE_URL}/rest/v1/{table}?rank=gte.0",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {SUPABASE_ANON_KEY}"},
        timeout=60,
    )
    res.raise_for_status()


def supabase_insert(table: str, rows: list[dict]) -> None:
    if not rows:
        return
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=rows,
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
    supabase_delete_all("card_price_predictions")
    supabase_insert("card_price_predictions", rows)
    print("完了。")


if __name__ == "__main__":
    main()
