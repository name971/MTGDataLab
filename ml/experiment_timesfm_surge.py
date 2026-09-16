"""
experiment_timesfm.pyの追試: ランダムサンプルではなく「実際にHORIZON日間で
大きく値上がりしたカード」だけに絞って、TimesFM-3のゼロショット予測が
その値上がりを検知できるか（方向的中・下落として誤予測しないか）を見る。

本番の学習データが「高騰したカードだけ」に絞られているのと条件を揃えるため、
まず実際の未来リターンで候補を選別してから予測させる（=正解を知った上での
事後選別なので、本番の「まだ未来を知らない状態での予測」より簡単な問題設定
になる点に注意。それでも当てられないなら尚更ダメ、というテスト）。

ponytail: 使い捨て検証スクリプト。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import timesfm

DATA_DIR = "data"
HORIZON = 7
MIN_HISTORY_DAYS = 120
CONTEXT_DAYS = 90
SURGE_THRESHOLD_PCT = 15.0  # HORIZON日間でこれ以上上がったカードだけを対象にする
SAMPLE_SIZE = 60


def main() -> None:
    df = pd.read_parquet(f"{DATA_DIR}/price_history.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["oracle_id", "date"])

    counts = df.groupby("oracle_id").size()
    eligible = counts[counts >= MIN_HISTORY_DAYS].index
    print(f"履歴{MIN_HISTORY_DAYS}日以上のオラクル: {len(eligible)}件")

    # 各オラクルについて「末尾HORIZON日で何%動いたか」を計算し、SURGE_THRESHOLD_PCT
    # 以上上がったものだけを候補にする
    surge_candidates = []
    for oracle_id in eligible:
        series = df[df["oracle_id"] == oracle_id]
        if len(series) < MIN_HISTORY_DAYS:
            continue
        values = series["jpy_est"].values
        split_idx = len(values) - HORIZON
        if split_idx < 30:
            continue
        last_value = values[split_idx - 1]
        actual_final = values[-1]
        if last_value <= 0:
            continue
        pct_change = (actual_final - last_value) / last_value * 100
        if pct_change >= SURGE_THRESHOLD_PCT:
            surge_candidates.append(oracle_id)

    print(f"実際に{SURGE_THRESHOLD_PCT}%以上値上がりしたオラクル: {len(surge_candidates)}件")

    rng = np.random.default_rng(42)
    sample_ids = rng.choice(surge_candidates, size=min(SAMPLE_SIZE, len(surge_candidates)), replace=False)

    print("TimesFM-3をロード中...")
    model = timesfm.TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch")

    results = []
    for oracle_id in sample_ids:
        series = df[df["oracle_id"] == oracle_id].reset_index(drop=True)
        values = series["jpy_est"].values
        split_idx = len(values) - HORIZON
        context = values[max(0, split_idx - CONTEXT_DAYS):split_idx]
        actual_future = values[split_idx:]
        last_value = context[-1]
        actual_final = float(actual_future[-1])

        try:
            out = model.predict(context=context.astype(np.float32), horizon=HORIZON)
            pred_final = float(np.asarray(out.forecast).reshape(-1)[-1])
        except Exception as e:  # noqa: BLE001
            print(f"  スキップ（推論失敗）: {oracle_id} ({e})")
            continue

        # 直近の勢い（末尾7日の傾き）をそのまま延長する、という別のシンプルなベースラインも試す
        recent = context[-7:]
        trend_per_day = (recent[-1] - recent[0]) / max(len(recent) - 1, 1)
        trend_pred = last_value + trend_per_day * HORIZON

        actual_pct = (actual_final - last_value) / last_value * 100
        timesfm_pct = (pred_final - last_value) / last_value * 100
        trend_pct = (trend_pred - last_value) / last_value * 100

        results.append({
            "oracle_id": oracle_id,
            "last_value": last_value,
            "actual_pct": actual_pct,
            "timesfm_pct": timesfm_pct,
            "trend_pct": trend_pct,
            "timesfm_caught_up": timesfm_pct > 0,
            "trend_caught_up": trend_pct > 0,
        })

    res_df = pd.DataFrame(results)
    print(f"\n検証件数: {len(res_df)}（全て実際は値上がりしたカード、平均+{res_df['actual_pct'].mean():.1f}%）")
    print(f"TimesFMが「上がる」と予測できた割合: {res_df['timesfm_caught_up'].mean()*100:.1f}%")
    print(f"TimesFM予測の値上がり幅の平均: +{res_df['timesfm_pct'].mean():.1f}%（実際は+{res_df['actual_pct'].mean():.1f}%）")
    print(f"直近7日のトレンド延長が「上がる」と予測できた割合: {res_df['trend_caught_up'].mean()*100:.1f}%")
    print(f"トレンド延長予測の値上がり幅の平均: +{res_df['trend_pct'].mean():.1f}%")

    res_df.to_csv("experiment_timesfm_surge_results.csv", index=False)
    print("\n詳細結果: ml/experiment_timesfm_surge_results.csv")


if __name__ == "__main__":
    main()
