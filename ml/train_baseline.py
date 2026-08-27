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

from features import FEATURE_COLUMNS, SEGMENTS, TARGET_COLUMN, build_training_frame

RANDOM_SEED = 42

# 中央値（alpha=0.5）に加えて下側/上側の分位点も学習し、予測区間（確信度）を出す。
QUANTILE_ALPHAS = (0.1, 0.5, 0.9)


def _fit_quantile_model(train_df: pd.DataFrame, alpha: float) -> lgb.LGBMRegressor:
    model = lgb.LGBMRegressor(
        objective="quantile",
        alpha=alpha,
        random_state=RANDOM_SEED,
        n_estimators=200,
        num_leaves=31,
        min_child_samples=20,
        verbose=-1,
    )
    model.fit(train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN])
    return model

# Winsorizing（学習データの目的変数を上下1%でクリップ）は試したが逆効果だった
# （2026-08-16、docs/price-prediction-plan.md参照）。禁止改定等の急変動は再現性の
# 無いノイズではなく、is_banned/reprint_count等の特徴量で学習すべき実信号だったため、
# クリップするとテスト側の急変動をむしろ外しやすくなった。


@dataclass
class FoldResult:
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    n_train: int
    n_test: int
    mae: float
    rmse: float
    directional_accuracy: float
    # 実測値がpred_0.1〜pred_0.9の区間に収まった割合。alpha=0.1/0.9で学習していれば
    # 理論上80%に近づくはず（区間のキャリブレーションが取れているかの確認用）。
    interval_coverage: float
    # 区間の平均幅（対数リターン）。狭いほどモデルが自信を持っている。
    mean_interval_width: float


def _pick_window_days(available_days: int) -> tuple[int, int, int]:
    """データ量に応じて (train_days, test_days, step_days) を決める。
    2026-08-15のR2移行で価格履歴が2024-02〜の約2.5年分（900日超）に拡大したため、
    指示書の想定（2年訓練/3ヶ月テスト）に近い窓を使えるようになった
    （docs/price-prediction-plan.md参照）。データが少なかった頃の縮小ロジック
    （180日未満の分岐）は当面使われない見込みだが、将来別の理由でデータ期間が
    短くなるケース（対象カードを絞った時等）に備えて残す。"""
    if available_days >= 730:
        return 540, 60, 60
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

    model_low = _fit_quantile_model(train_df, 0.1)
    model_mid = _fit_quantile_model(train_df, 0.5)
    model_high = _fit_quantile_model(train_df, 0.9)

    pred = model_mid.predict(test_df[FEATURE_COLUMNS])
    pred_low = model_low.predict(test_df[FEATURE_COLUMNS])
    pred_high = model_high.predict(test_df[FEATURE_COLUMNS])
    # 分位点モデルは独立に学習しているため、まれにlow > mid > highの交差が起こりうる。
    # 単調性を保証する（quantile crossing対策）。
    pred_low = np.minimum(pred_low, pred)
    pred_high = np.maximum(pred_high, pred)
    actual = test_df[TARGET_COLUMN].to_numpy()

    mae = float(np.mean(np.abs(pred - actual)))
    rmse = float(np.sqrt(np.mean((pred - actual) ** 2)))
    directional_accuracy = float(np.mean(np.sign(pred) == np.sign(actual)))
    interval_coverage = float(np.mean((actual >= pred_low) & (actual <= pred_high)))
    mean_interval_width = float(np.mean(pred_high - pred_low))

    return FoldResult(
        test_start=train_end,
        test_end=test_end,
        n_train=len(train_df),
        n_test=len(test_df),
        mae=mae,
        rmse=rmse,
        directional_accuracy=directional_accuracy,
        interval_coverage=interval_coverage,
        mean_interval_width=mean_interval_width,
    )


def print_top_movers(frame: pd.DataFrame, static_attrs_by_oracle: pd.DataFrame) -> None:
    """全期間で学習した最終モデルで、直近日付時点の特徴量から「今後1週間で上昇が
    期待できるトップ10」を出す（参考情報。厳密なバックテストではない）。"""
    labeled = frame.dropna(subset=[TARGET_COLUMN])
    if labeled.empty:
        print("目的変数が計算できる行が無いため、Top10予測はスキップします。")
        return

    model_low = _fit_quantile_model(labeled, 0.1)
    model_mid = _fit_quantile_model(labeled, 0.5)
    model_high = _fit_quantile_model(labeled, 0.9)

    latest_date = frame["date"].max()
    # return_30d等、まだ十分な日数が無く恒常的にNaNになる特徴量もある。LightGBMは欠損値を
    # ネイティブに扱える（学習時もdropna(subset=FEATURE_COLUMNS)はしていない）ため、
    # ここでも全列非欠損を要求しない。jpy_est（現在価格の表示用）だけは必須とする。
    latest = frame[frame["date"] == latest_date].dropna(subset=["jpy_est"])
    if latest.empty:
        print("最新日の価格データが無いため、Top10予測はスキップします。")
        return

    latest = latest.copy()
    latest["pred_low"] = np.minimum(model_low.predict(latest[FEATURE_COLUMNS]), model_mid.predict(latest[FEATURE_COLUMNS]))
    latest["predicted_log_return_7d"] = model_mid.predict(latest[FEATURE_COLUMNS])
    latest["pred_high"] = np.maximum(model_high.predict(latest[FEATURE_COLUMNS]), latest["predicted_log_return_7d"])
    latest["interval_width"] = latest["pred_high"] - latest["pred_low"]

    top10 = latest.sort_values("predicted_log_return_7d", ascending=False).head(10)
    print(f"\n=== {latest_date.date()} 時点: 今後1週間の予測上昇率トップ10（中央値ベース） ===")
    for _, row in top10.iterrows():
        pct = (np.exp(row["predicted_log_return_7d"]) - 1) * 100
        pct_low = (np.exp(row["pred_low"]) - 1) * 100
        pct_high = (np.exp(row["pred_high"]) - 1) * 100
        print(f"  {row['oracle_id']}: {pct:+.1f}%（80%区間 {pct_low:+.1f}%〜{pct_high:+.1f}%、現在価格 {row['jpy_est']:.0f}円）")

    # 確信度フィルター: 中央値が上位20%、かつ区間幅も狭い方から選ぶ（DeepSeek提案の運用イメージ）
    strong_up = latest[latest["predicted_log_return_7d"] >= latest["predicted_log_return_7d"].quantile(0.8)]
    confident_picks = strong_up.sort_values("interval_width").head(10)
    print(f"\n=== 確信度フィルター（予測上位20%のうち区間幅が狭い順トップ10） ===")
    for _, row in confident_picks.iterrows():
        pct = (np.exp(row["predicted_log_return_7d"]) - 1) * 100
        pct_low = (np.exp(row["pred_low"]) - 1) * 100
        pct_high = (np.exp(row["pred_high"]) - 1) * 100
        print(f"  {row['oracle_id']}: {pct:+.1f}%（80%区間 {pct_low:+.1f}%〜{pct_high:+.1f}%、現在価格 {row['jpy_est']:.0f}円）")


def run_segment(segment: str) -> None:
    print(f"\n{'='*20} セグメント: {segment} {'='*20}")
    print("特徴量データフレームを構築中...")
    frame = build_training_frame(segment)
    # log_return_7d はshift(-7)で計算しているため、直近7日分の行は目的変数が欠損する
    # （まだ7日後が来ていないため）。ウォークフォワードの窓は「目的変数が計算できる
    # 日付範囲」だけで組む（そうしないと終盤のフォールドがサンプル0件になる）。
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
    importances = []  # 特徴量重要度検証用（2026-08-27）: 各フォールドのmodel_midの重要度を集計
    for train_start, train_end, test_end in folds:
        result = train_and_evaluate_fold(frame, train_start, train_end, test_end)
        if result:
            results.append(result)
            print(
                f"  fold [{result.test_start.date()}〜{result.test_end.date()}): "
                f"train={result.n_train} test={result.n_test} "
                f"MAE={result.mae:.4f} RMSE={result.rmse:.4f} "
                f"方向的中率={result.directional_accuracy:.1%} "
                f"区間カバレッジ={result.interval_coverage:.1%} "
                f"区間幅={result.mean_interval_width:.4f}"
            )
            train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(
                subset=[TARGET_COLUMN]
            )
            model_mid = _fit_quantile_model(train_df, 0.5)
            importances.append(model_mid.feature_importances_)

    if not results:
        print("全フォールドでサンプル数不足のため評価できませんでした。")
        return

    print(f"\n=== {segment} 全フォールド平均 ===")
    print(f"MAE: {np.mean([r.mae for r in results]):.4f}")
    print(f"RMSE: {np.mean([r.rmse for r in results]):.4f}")
    print(f"方向的中率: {np.mean([r.directional_accuracy for r in results]):.1%}")
    print(f"区間カバレッジ（alpha=0.1〜0.9、理想は80%前後）: {np.mean([r.interval_coverage for r in results]):.1%}")
    print(f"平均区間幅（対数リターン）: {np.mean([r.mean_interval_width for r in results]):.4f}")
    print(f"フォールド数: {len(results)}")

    if importances:
        avg_importance = np.mean(importances, axis=0)
        ranked = sorted(zip(FEATURE_COLUMNS, avg_importance), key=lambda x: -x[1])
        print(f"\n=== {segment} 特徴量重要度（全フォールド平均、model_mid） ===")
        for i, (name, imp) in enumerate(ranked, start=1):
            print(f"  {i:2d}. {name}: {imp:.1f}")

    print_top_movers(frame, frame)


def main() -> None:
    for segment in SEGMENTS:
        run_segment(segment)


if __name__ == "__main__":
    main()
