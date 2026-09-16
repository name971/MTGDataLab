"""
TimesFM-3（Googleのゼロショット時系列予測基盤モデル）が、うちの価格予測に
使えそうか小さく検証するための使い捨てスクリプト。

手法: price_history.parquet（キャッシュ済み、fetch_data.py参照）から履歴が
十分に長いオラクルをサンプリングし、「T日目までの価格を文脈としてT+7日目を
ゼロショット予測→実際の値と比較」というwalk-forward検証を行う。
比較対象は「単純に横ばい継続（最後の値をそのまま予測）」という素朴なベースライン。

ponytail: 使い捨て検証スクリプト。本番コードには組み込まない。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import timesfm

DATA_DIR = "data"
HORIZON = 7
MIN_HISTORY_DAYS = 120
SAMPLE_SIZE = 60
CONTEXT_DAYS = 90


def main() -> None:
    df = pd.read_parquet(f"{DATA_DIR}/price_history.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["oracle_id", "date"])

    counts = df.groupby("oracle_id").size()
    eligible = counts[counts >= MIN_HISTORY_DAYS].index
    print(f"履歴{MIN_HISTORY_DAYS}日以上のオラクル: {len(eligible)}件")

    rng = np.random.default_rng(42)
    sample_ids = rng.choice(eligible, size=min(SAMPLE_SIZE, len(eligible)), replace=False)

    print("TimesFM-3をロード中...")
    model = timesfm.TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch")

    results = []
    for oracle_id in sample_ids:
        series = df[df["oracle_id"] == oracle_id].reset_index(drop=True)
        if len(series) < MIN_HISTORY_DAYS:
            continue
        # 末尾HORIZON日を「実際の未来」として隠し、それより前をcontextにする
        split_idx = len(series) - HORIZON
        context = series["jpy_est"].values[max(0, split_idx - CONTEXT_DAYS):split_idx]
        actual_future = series["jpy_est"].values[split_idx:]
        if len(context) < 30 or len(actual_future) < HORIZON:
            continue
        last_value = context[-1]

        try:
            out = model.predict(context=context.astype(np.float32), horizon=HORIZON)
            pred_final = float(np.asarray(out.forecast).reshape(-1)[-1])
        except Exception as e:  # noqa: BLE001
            print(f"  スキップ（推論失敗）: {oracle_id} ({e})")
            continue

        actual_final = float(actual_future[-1])
        naive_pred = last_value  # 素朴ベースライン: 横ばい継続

        actual_direction = "up" if actual_final > last_value else "down" if actual_final < last_value else "flat"
        timesfm_direction = "up" if pred_final > last_value else "down" if pred_final < last_value else "flat"
        naive_direction = "flat"  # 定義上、横ばい予測は常にflat

        results.append({
            "oracle_id": oracle_id,
            "last_value": last_value,
            "actual_final": actual_final,
            "timesfm_pred": pred_final,
            "actual_direction": actual_direction,
            "timesfm_direction": timesfm_direction,
            "timesfm_hit": actual_direction == timesfm_direction and actual_direction != "flat",
            "timesfm_abs_pct_err": abs(pred_final - actual_final) / max(actual_final, 1e-6) * 100,
            "naive_abs_pct_err": abs(naive_pred - actual_final) / max(actual_final, 1e-6) * 100,
        })

    res_df = pd.DataFrame(results)
    print(f"\n検証件数: {len(res_df)}")
    if len(res_df) == 0:
        return

    directional_cards = res_df[res_df["actual_direction"] != "flat"]
    hit_rate = directional_cards["timesfm_hit"].mean() * 100 if len(directional_cards) > 0 else float("nan")
    print(f"方向的中率（up/down、flat除く、n={len(directional_cards)}）: {hit_rate:.1f}%")
    print(f"TimesFM 平均絶対誤差率: {res_df['timesfm_abs_pct_err'].mean():.1f}%")
    print(f"素朴ベースライン（横ばい継続）平均絶対誤差率: {res_df['naive_abs_pct_err'].mean():.1f}%")
    print(f"TimesFMが素朴ベースラインに勝った件数: {(res_df['timesfm_abs_pct_err'] < res_df['naive_abs_pct_err']).sum()} / {len(res_df)}")

    res_df.to_csv("experiment_timesfm_results.csv", index=False)
    print("\n詳細結果: ml/experiment_timesfm_results.csv")


if __name__ == "__main__":
    main()
