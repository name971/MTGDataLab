"""
単一LightGBM（objective=quantile, alpha=0.5）によるベースラインモデルのウォークフォワード評価。

指示書の想定（2020-2024、2年訓練/3ヶ月テスト）は現状のデータ量（最大でもMTGJSON補完込みで
90日程度）では実行不可能なため、利用可能な日数に応じて訓練/テスト窓を自動的に縮小する。
データが半年〜1年分溜まった時点で、WINDOW設定を元の指示書に近い値へ戻せばよい。

実行: python ml/train_baseline.py
"""

from __future__ import annotations

from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd

from features import FEATURE_COLUMNS, TARGET_COLUMN, build_training_frame

RANDOM_SEED = 42


@dataclass
class FoldResult:
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    n_train: int
    n_test: int
    mae: float
    rmse: float
    directional_accuracy: float


def _pick_window_days(available_days: int) -> tuple[int, int, int]:
    """データ量に応じて (train_days, test_days, step_days) を決める。
    半年（約180日）以上あれば指示書に近い比率（train:test = 8:1）を使い、
    それ未満なら手元のデータで最低限フォールドが作れるだけの窓に縮める。"""
    if available_days >= 180:
        return 120, 15, 15
    if available_days >= 60:
        return 30, 7, 7
    if available_days >= 20:
        return max(available_days - 14, 14), 7, 7
    # MTGJSONの90日ローリング補完を入れてもまだ日数が少ない現状（2026年8月時点で
    # 実質20日弱）を想定した最小構成。1〜2フォールドしか作れずスコアの信頼性は低いが、
    # パイプライン自体の動作確認とベースライン精度の大まかな目安にはなる。
    test_days = max(available_days // 4, 3)
    train_days = max(available_days - test_days, test_days)
    return train_days, test_days, test_days


def walk_forward_folds(dates: pd.DatetimeIndex) -> list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]]:
    available_days = (dates.max() - dates.min()).days
    train_days, test_days, step_days = _pick_window_days(available_days)
    print(
        f"データ期間: {available_days}日 → train={train_days}日 / test={test_days}日 / "
        f"step={step_days}日 でウォークフォワード分割"
    )

    folds = []
    train_start = dates.min()
    while True:
        train_end = train_start + pd.Timedelta(days=train_days)
        test_end = train_end + pd.Timedelta(days=test_days)
        if test_end > dates.max():
            break
        folds.append((train_start, train_end, test_end))
        train_start += pd.Timedelta(days=step_days)
    return folds


def train_and_evaluate_fold(
    frame: pd.DataFrame, train_start: pd.Timestamp, train_end: pd.Timestamp, test_end: pd.Timestamp
) -> FoldResult | None:
    train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(
        subset=[TARGET_COLUMN]
    )
    test_df = frame[(frame["date"] >= train_end) & (frame["date"] < test_end)].dropna(
        subset=[TARGET_COLUMN]
    )
    if len(train_df) < 50 or len(test_df) < 10:
        # サンプル数が少なすぎるフォールドは学習が不安定になるためスキップする
        return None

    model = lgb.LGBMRegressor(
        objective="quantile",
        alpha=0.5,
        random_state=RANDOM_SEED,
        n_estimators=200,
        num_leaves=31,
        min_child_samples=20,
        verbose=-1,
    )
    model.fit(train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN])

    pred = model.predict(test_df[FEATURE_COLUMNS])
    actual = test_df[TARGET_COLUMN].to_numpy()

    mae = float(np.mean(np.abs(pred - actual)))
    rmse = float(np.sqrt(np.mean((pred - actual) ** 2)))
    directional_accuracy = float(np.mean(np.sign(pred) == np.sign(actual)))

    return FoldResult(
        test_start=train_end,
        test_end=test_end,
        n_train=len(train_df),
        n_test=len(test_df),
        mae=mae,
        rmse=rmse,
        directional_accuracy=directional_accuracy,
    )


def print_top_movers(frame: pd.DataFrame, static_attrs_by_oracle: pd.DataFrame) -> None:
    """全期間で学習した最終モデルで、直近日付時点の特徴量から「今後1週間で上昇が
    期待できるトップ10」を出す（参考情報。厳密なバックテストではない）。"""
    labeled = frame.dropna(subset=[TARGET_COLUMN])
    if labeled.empty:
        print("目的変数が計算できる行が無いため、Top10予測はスキップします。")
        return

    model = lgb.LGBMRegressor(
        objective="quantile",
        alpha=0.5,
        random_state=RANDOM_SEED,
        n_estimators=200,
        num_leaves=31,
        min_child_samples=20,
        verbose=-1,
    )
    model.fit(labeled[FEATURE_COLUMNS], labeled[TARGET_COLUMN])

    latest_date = frame["date"].max()
    # return_30d等、まだ十分な日数が無く恒常的にNaNになる特徴量もある。LightGBMは欠損値を
    # ネイティブに扱える（学習時もdropna(subset=FEATURE_COLUMNS)はしていない）ため、
    # ここでも全列非欠損を要求しない。jpy_est（現在価格の表示用）だけは必須とする。
    latest = frame[frame["date"] == latest_date].dropna(subset=["jpy_est"])
    if latest.empty:
        print("最新日の価格データが無いため、Top10予測はスキップします。")
        return

    latest = latest.copy()
    latest["predicted_log_return_7d"] = model.predict(latest[FEATURE_COLUMNS])
    top10 = latest.sort_values("predicted_log_return_7d", ascending=False).head(10)

    print(f"\n=== {latest_date.date()} 時点: 今後1週間の予測上昇率トップ10 ===")
    for _, row in top10.iterrows():
        pct = (np.exp(row["predicted_log_return_7d"]) - 1) * 100
        print(f"  {row['oracle_id']}: 予測変化率 {pct:+.1f}%（現在価格 {row['jpy_est']:.0f}円）")


def main() -> None:
    print("特徴量データフレームを構築中...")
    frame = build_training_frame()
    # log_return_7d はshift(-7)で計算しているため、直近7日分の行は目的変数が欠損する
    # （まだ7日後が来ていないため）。ウォークフォワードの窓は「目的変数が計算できる
    # 日付範囲」だけで組む（そうしないと終盤のフォールドがサンプル0件になる）。
    labeled_dates = frame.loc[frame[TARGET_COLUMN].notna(), "date"]
    dates = pd.DatetimeIndex(labeled_dates.unique()).sort_values()
    if len(dates) < 10:
        raise SystemExit(
            f"日付のバリエーションが{len(dates)}日しかなく、評価不可能です。"
            "ml/fetch_data.py を先に実行してデータを揃えてください。"
        )

    folds = walk_forward_folds(dates)
    if not folds:
        raise SystemExit(
            "有効なフォールドを1つも作れませんでした。データ期間が短すぎる可能性があります。"
        )

    results = []
    for train_start, train_end, test_end in folds:
        result = train_and_evaluate_fold(frame, train_start, train_end, test_end)
        if result:
            results.append(result)
            print(
                f"  fold [{result.test_start.date()}〜{result.test_end.date()}): "
                f"train={result.n_train} test={result.n_test} "
                f"MAE={result.mae:.4f} RMSE={result.rmse:.4f} "
                f"方向的中率={result.directional_accuracy:.1%}"
            )

    if not results:
        raise SystemExit("全フォールドでサンプル数不足のため評価できませんでした。")

    print("\n=== 全フォールド平均 ===")
    print(f"MAE: {np.mean([r.mae for r in results]):.4f}")
    print(f"RMSE: {np.mean([r.rmse for r in results]):.4f}")
    print(f"方向的中率: {np.mean([r.directional_accuracy for r in results]):.1%}")
    print(f"フォールド数: {len(results)}")

    print_top_movers(frame, frame)


if __name__ == "__main__":
    main()
