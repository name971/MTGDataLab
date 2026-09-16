"""
experiment_timesfm_surge.pyの下降版。実際にHORIZON日間で大きく値下がりした
カードだけに絞って、TimesFM-3のゼロショット予測がその下落を検知できるかを見る。

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
CRASH_THRESHOLD_PCT = -15.0  # HORIZON日間でこれ以下に下がったカードだけを対象にする
SAMPLE_SIZE = 60


def main() -> None:
    df = pd.read_parquet(f"{DATA_DIR}/price_history.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["oracle_id", "date"])

    counts = df.groupby("oracle_id").size()
    eligible = counts[counts >= MIN_HISTORY_DAYS].index
    print(f"履歴{MIN_HISTORY_DAYS}日以上のオラクル: {len(eligible)}件")

    crash_candidates = []
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
        if pct_change <= CRASH_THRESHOLD_PCT:
            crash_candidates.append(oracle_id)

    print(f"実際に{CRASH_THRESHOLD_PCT}%以下に値下がりしたオラクル: {len(crash_candidates)}件")

    rng = np.random.default_rng(42)
    sample_ids = rng.choice(crash_candidates, size=min(SAMPLE_SIZE, len(crash_candidates)), replace=False)

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
            "timesfm_caught_down": timesfm_pct < 0,
            "trend_caught_down": trend_pct < 0,
        })

    res_df = pd.DataFrame(results)
    print(f"\n検証件数: {len(res_df)}（全て実際は値下がりしたカード、平均{res_df['actual_pct'].mean():.1f}%）")
    print(f"TimesFMが「下がる」と予測できた割合: {res_df['timesfm_caught_down'].mean()*100:.1f}%")
    print(f"TimesFM予測の値下がり幅の平均: {res_df['timesfm_pct'].mean():.1f}%（実際は{res_df['actual_pct'].mean():.1f}%）")
    print(f"直近7日のトレンド延長が「下がる」と予測できた割合: {res_df['trend_caught_down'].mean()*100:.1f}%")
    print(f"トレンド延長予測の値下がり幅の平均: {res_df['trend_pct'].mean():.1f}%")

    res_df.to_csv("experiment_timesfm_crash_results.csv", index=False)
    print("\n詳細結果: ml/experiment_timesfm_crash_results.csv")


if __name__ == "__main__":
    main()
