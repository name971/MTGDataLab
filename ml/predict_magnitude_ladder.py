"""
「上がるか/上がらないか」の単一判定ではなく、「+5%以上の確率70%、+10%以上40%、
+15%以上15%」のように複数の閾値で確率を段階的に出す（ユーザー指摘: 知りたいのは
「上がるかどうか」だけでなく「どれくらい上がるか」でもあるはず、2026-08-16）。

やり方: 閾値ごとに別々のLightGBM分類器（class_weight="balanced"、
train_classification.pyと同じcost-aware設計）を学習するが、素朴に確率を並べると
閾値が厳しいモデルほどclass_weight="balanced"の重み付けが強くなり、出力される
「確率」が体系的に閾値と逆相関してしまう（+20%以上の確率が+5%以上の確率より
高くなるという矛盾が実際に発生した）。CalibratedClassifierCV（等調回帰）で
各モデルの確率を実測ベースに校正し直すことでほぼ解消するが、それでも数%は
単調性（緩い閾値の確率 >= 厳しい閾値の確率）が破れるため、仕上げに閾値の緩い方から
順にnp.minimumで押さえ込む後処理を入れて完全に単調にする。

実行: python ml/predict_magnitude_ladder.py
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV

from features import FEATURE_COLUMNS, TARGET_COLUMN, build_training_frame
from train_classification import RANDOM_SEED, _compute_labels

THRESHOLDS_PCT = (5, 10, 15, 20)


def fit_calibrated_ladder(
    train_df: pd.DataFrame, test_df: pd.DataFrame, *, direction: str = "up"
) -> dict[int, CalibratedClassifierCV]:
    models = {}
    for x in THRESHOLDS_PCT:
        train_label, _ = _compute_labels(
            train_df, test_df, soar_quantile=0.9, fixed_threshold_pct=x, direction=direction
        )
        if train_label.sum() < 5:
            continue
        base = lgb.LGBMClassifier(
            random_state=RANDOM_SEED, n_estimators=200, num_leaves=31,
            min_child_samples=20, class_weight="balanced", verbose=-1,
        )
        # cv=3: 内部で3分割して確率校正用のホールドアウトを作る（テストデータは使わない）
        calibrated = CalibratedClassifierCV(base, method="isotonic", cv=3)
        calibrated.fit(train_df[FEATURE_COLUMNS], train_label)
        models[x] = calibrated
    return models


def predict_ladder(models: dict[int, CalibratedClassifierCV], rows: pd.DataFrame) -> pd.DataFrame:
    """閾値の緩い順（5→20）に確率を計算し、単調性（緩い閾値ほど確率が高い）を
    np.minimumの累積適用で強制する。"""
    result = pd.DataFrame(index=rows.index)
    prev_col = None
    for x in sorted(models.keys()):
        raw = models[x].predict_proba(rows[FEATURE_COLUMNS])[:, 1]
        col = f"p_{x}"
        if prev_col is None:
            result[col] = raw
        else:
            result[col] = np.minimum(raw, result[prev_col])
        prev_col = col
    return result


def main() -> None:
    print("特徴量データフレームを構築中（competitive）...")
    frame = build_training_frame("competitive")
    labeled = frame.dropna(subset=[TARGET_COLUMN])

    # 直近540日を訓練に使い、直近日付のカードに予測を出す（train_baseline.pyの
    # print_top_moversと同じ考え方。最終検証ではなく実運用イメージの確認用）
    train_end = labeled["date"].max() - pd.Timedelta(days=7)
    train_start = train_end - pd.Timedelta(days=540)
    train_df = labeled[(labeled["date"] >= train_start) & (labeled["date"] < train_end)]

    print("閾値ごとのキャリブレーション済みモデルを学習中...")
    models = fit_calibrated_ladder(train_df, train_df)  # ここではtest_dfは使わないのでダミーでtrain_dfを渡す

    latest_date = frame["date"].max()
    latest = frame[frame["date"] == latest_date].dropna(subset=["jpy_est"]).copy()
    ladder = predict_ladder(models, latest)
    latest = latest.join(ladder)

    violations = 0
    cols = [f"p_{x}" for x in sorted(models.keys())]
    for i in range(len(cols) - 1):
        violations += (latest[cols[i]] < latest[cols[i + 1]]).sum()
    print(f"単調性違反（後処理後）: {violations}行（0であるべき）")

    top10 = latest.sort_values(cols[0], ascending=False).head(10)
    print(f"\n=== {latest_date.date()} 時点: 値上がり確率の段階表示トップ10 ===")
    for _, row in top10.iterrows():
        parts = " ".join(f"P(+{x}%)={row[f'p_{x}']:.0%}" for x in sorted(models.keys()))
        print(f"  {row['oracle_id']}: {parts}（現在価格 {row['jpy_est']:.0f}円）")


if __name__ == "__main__":
    main()
