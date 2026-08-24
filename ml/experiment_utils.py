"""
特徴量・パラメータの候補を複数試してTop-N的中率を比較する使い回しハーネス。
2026-08、新しい特徴量を試すたびに「walk_forward_folds→evaluate_top_nをループで回す」
ほぼ同じコードを実験スクリプトごとに書き直していたため切り出した（2026-08-25）。

注意: これはtrain_classification.py（研究用の単純な単一分類器）を使った比較であり、
実際にサイトの予測に使われているpredict_magnitude_ladder.py（閾値ごとに4分類器＋
CalibratedClassifierCVで較正）とは別のパラメータ・構造を持つ。ここでの改善が本番に
そのまま反映されるとは限らない（2026-08-23、n_estimatorsの検証で研究用と本番用で
真逆の結果になった実績があるため、本番相当での検証が必要な変更は別途行うこと）。

使い方:
    from experiment_utils import compare_feature_columns
    from features import build_training_frame, FEATURE_COLUMNS

    frame = build_training_frame("competitive")
    compare_feature_columns(frame, {
        "baseline": FEATURE_COLUMNS,
        "+new_feature": FEATURE_COLUMNS + ["new_feature"],
    })
"""

from __future__ import annotations

import pandas as pd

from train_baseline import walk_forward_folds
from train_classification import SEGMENT_LGBM_PARAMS, TARGET_COLUMN, evaluate_top_n


def compare_feature_columns(
    frame: pd.DataFrame,
    configs: dict[str, list[str]],
    *,
    segment: str = "competitive",
    directions: tuple[str, ...] = ("up", "down"),
    top_n_values: tuple[int, ...] = (10, 20, 50, 100),
) -> None:
    """configsの各(名前, 特徴量リスト)についてwalk-forward検証し、Top-N的中率を表示する。"""
    dates = pd.DatetimeIndex(frame.loc[frame[TARGET_COLUMN].notna(), "date"].unique()).sort_values()
    folds = walk_forward_folds(dates)
    lgbm_params = SEGMENT_LGBM_PARAMS.get(segment)

    for name, cols in configs.items():
        print(f"\n===== {name} =====")
        for direction in directions:
            print(f"--- {direction} ---")
            evaluate_top_n(
                frame, folds, direction=direction, lgbm_params=lgbm_params,
                feature_columns=cols, top_n_values=top_n_values,
            )
