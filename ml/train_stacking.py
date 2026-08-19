"""
LightGBM + CatBoost + Ridge のスタッキングアンサンブルを試す実験スクリプト。
train_baseline.py（単一LightGBM、alpha=0.5中央値のみ比較対象）と同じウォークフォワード
分割・評価指標で、素朴な単一LightGBMより精度が上がるかを検証する。

スタッキングの手順（各フォールドごと）:
  1. train_dfを日付で train_inner（先頭80%）/ meta_holdout（末尾20%）に分ける
  2. train_innerで3つのベースモデル（LightGBM/CatBoost/Ridge）を学習
  3. meta_holdoutでの各モデルの予測値を特徴量にして、メタモデル（線形回帰）を学習
     （ベースモデルの重み付けを自動的に学習させる）
  4. 最終的な予測には、train_df全体で再学習したベースモデル + 上記メタモデルを使う
     （手順2は重み学習専用で、本番予測にはデータを無駄にせず全期間を使う）

Ridgeは欠損値を扱えないため中央値補完+標準化が必要（LightGBM/CatBoostは欠損値を
ネイティブに扱えるため補完不要）。

実行: python ml/train_stacking.py
"""

from __future__ import annotations

from dataclasses import dataclass

import catboost as cb
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.preprocessing import StandardScaler

from features import FEATURE_COLUMNS, SEGMENTS, TARGET_COLUMN, build_training_frame
from train_baseline import walk_forward_folds

RANDOM_SEED = 42
META_HOLDOUT_FRACTION = 0.2


@dataclass
class FoldResult:
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    mae: float
    rmse: float
    directional_accuracy: float
    meta_weights: dict[str, float]


def _fit_lgb(train_df: pd.DataFrame) -> lgb.LGBMRegressor:
    model = lgb.LGBMRegressor(
        objective="quantile", alpha=0.5, random_state=RANDOM_SEED,
        n_estimators=200, num_leaves=31, min_child_samples=20, verbose=-1,
    )
    model.fit(train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN])
    return model


def _fit_catboost(train_df: pd.DataFrame) -> cb.CatBoostRegressor:
    model = cb.CatBoostRegressor(
        loss_function="MAE", random_seed=RANDOM_SEED,
        iterations=200, depth=6, verbose=False,
    )
    model.fit(train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN])
    return model


class RidgeWithPreprocessing:
    """RidgeはNaNを扱えないため中央値補完+標準化を内包する薄いラッパー。"""

    def __init__(self) -> None:
        self.imputer = SimpleImputer(strategy="median")
        self.scaler = StandardScaler()
        self.model = Ridge(alpha=1.0, random_state=RANDOM_SEED)

    def fit(self, X: pd.DataFrame, y: pd.Series) -> "RidgeWithPreprocessing":
        X_imputed = self.imputer.fit_transform(X)
        X_scaled = self.scaler.fit_transform(X_imputed)
        self.model.fit(X_scaled, y)
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        X_imputed = self.imputer.transform(X)
        X_scaled = self.scaler.transform(X_imputed)
        return self.model.predict(X_scaled)


def _fit_ridge(train_df: pd.DataFrame) -> RidgeWithPreprocessing:
    return RidgeWithPreprocessing().fit(train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN])


def train_and_evaluate_fold(
    frame: pd.DataFrame, train_start: pd.Timestamp, train_end: pd.Timestamp, test_end: pd.Timestamp
) -> FoldResult | None:
    train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(subset=[TARGET_COLUMN])
    test_df = frame[(frame["date"] >= train_end) & (frame["date"] < test_end)].dropna(subset=[TARGET_COLUMN])
    if len(train_df) < 50 or len(test_df) < 10:
        return None

    # メタモデルの重み学習用に、訓練期間の末尾20%を時系列に沿って切り出す
    # （ランダム分割だと同じデッキ・近い日付の行がtrain_inner/meta_holdoutに混ざり
    # リークするため、日付ベースで分ける）
    train_dates = train_df["date"].sort_values().unique()
    split_idx = int(len(train_dates) * (1 - META_HOLDOUT_FRACTION))
    if split_idx < 10 or len(train_dates) - split_idx < 5:
        return None
    inner_cutoff = train_dates[split_idx]

    train_inner = train_df[train_df["date"] < inner_cutoff]
    meta_holdout = train_df[train_df["date"] >= inner_cutoff]
    if len(train_inner) < 30 or len(meta_holdout) < 10:
        return None

    lgb_inner = _fit_lgb(train_inner)
    cat_inner = _fit_catboost(train_inner)
    ridge_inner = _fit_ridge(train_inner)

    meta_features = np.column_stack([
        lgb_inner.predict(meta_holdout[FEATURE_COLUMNS]),
        cat_inner.predict(meta_holdout[FEATURE_COLUMNS]),
        ridge_inner.predict(meta_holdout[FEATURE_COLUMNS]),
    ])
    meta_model = LinearRegression()
    meta_model.fit(meta_features, meta_holdout[TARGET_COLUMN])

    # 本番予測用のベースモデルは、重み学習に使わなかった分も含めtrain_df全体で再学習する
    lgb_full = _fit_lgb(train_df)
    cat_full = _fit_catboost(train_df)
    ridge_full = _fit_ridge(train_df)

    test_meta_features = np.column_stack([
        lgb_full.predict(test_df[FEATURE_COLUMNS]),
        cat_full.predict(test_df[FEATURE_COLUMNS]),
        ridge_full.predict(test_df[FEATURE_COLUMNS]),
    ])
    pred = meta_model.predict(test_meta_features)
    actual = test_df[TARGET_COLUMN].to_numpy()

    mae = float(np.mean(np.abs(pred - actual)))
    rmse = float(np.sqrt(np.mean((pred - actual) ** 2)))
    directional_accuracy = float(np.mean(np.sign(pred) == np.sign(actual)))
    meta_weights = dict(zip(["lightgbm", "catboost", "ridge"], meta_model.coef_.tolist()))

    return FoldResult(
        test_start=train_end, test_end=test_end,
        mae=mae, rmse=rmse, directional_accuracy=directional_accuracy, meta_weights=meta_weights,
    )


def run_segment(segment: str) -> None:
    print(f"\n{'='*20} セグメント: {segment}（スタッキング） {'='*20}")
    print("特徴量データフレームを構築中...")
    frame = build_training_frame(segment)
    labeled_dates = frame.loc[frame[TARGET_COLUMN].notna(), "date"]
    dates = pd.DatetimeIndex(labeled_dates.unique()).sort_values()
    if len(dates) < 10:
        print(f"日付のバリエーションが{len(dates)}日しかなく、評価不可能です。スキップします。")
        return

    folds = walk_forward_folds(dates)
    if not folds:
        print("有効なフォールドを1つも作れませんでした。スキップします。")
        return

    results = []
    for train_start, train_end, test_end in folds:
        result = train_and_evaluate_fold(frame, train_start, train_end, test_end)
        if result:
            results.append(result)
            weights_str = ", ".join(f"{k}={v:+.3f}" for k, v in result.meta_weights.items())
            print(
                f"  fold [{result.test_start.date()}〜{result.test_end.date()}): "
                f"MAE={result.mae:.4f} RMSE={result.rmse:.4f} "
                f"方向的中率={result.directional_accuracy:.1%} "
                f"メタ重み=({weights_str})"
            )

    if not results:
        print("全フォールドでサンプル数不足のため評価できませんでした。")
        return

    print(f"\n=== {segment} 全フォールド平均（スタッキング） ===")
    print(f"MAE: {np.mean([r.mae for r in results]):.4f}")
    print(f"RMSE: {np.mean([r.rmse for r in results]):.4f}")
    print(f"方向的中率: {np.mean([r.directional_accuracy for r in results]):.1%}")
    print(f"フォールド数: {len(results)}")


def main() -> None:
    for segment in SEGMENTS:
        run_segment(segment)


if __name__ == "__main__":
    main()
