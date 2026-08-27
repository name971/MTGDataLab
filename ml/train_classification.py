"""
価格予測を回帰ではなく「急騰するか/しないか」の二値分類として再定義し、
不均衡データ対策（cost-aware、LightGBMのclass_weight='balanced'）の効果を検証する。

着想: Shishido & Niimi (2023) "Prediction Soaring Price by Decision Tree Dealing
with Imbalanced Data in Trading Card Game Market"（International Journal of
Digital Society）。この論文はMTG中古市場の価格急騰予測を決定木で二値分類した際、
不均衡データ対策を何もしないとRecall（急騰カードを実際に当てられた割合）が
0付近まで落ち込む（Accuracy自体は98%と高く見えるが、大半のカードを機械的に
「急騰しない」と予測しているだけ）ことを示し、undersampling/cost-aware
アプローチでRecallを大幅に改善できたと報告している。

今のml/train_baseline.pyは回帰＋符号一致率（方向的中率）で評価しているが、
これは「圧倒的多数を占めるほとんど動かないカード」に引っ張られやすく、
本来知りたい「大きく値上がりするカードを当てる」力を直接測れていない可能性がある。

「急騰」の定義: 各フォールドの訓練データ自体の分布から動的に閾値を決める
（セグメントごとに値動きのスケールが大きく違うため、固定の%閾値は不適切。
また訓練期間ごとに市場全体のボラティリティが変わるため、フォールドをまたいで
固定の閾値を使うと期間によって「急騰」の意味が変わってしまう）。
上位SOAR_QUANTILE（デフォルト90パーセンタイル＝上位10%）を「急騰」とする。

実行: python ml/train_classification.py
"""

from __future__ import annotations

from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import f1_score, precision_score, recall_score

from features import FEATURE_COLUMNS, SEGMENTS, TARGET_COLUMN, build_training_frame, target_column_for_direction
from train_baseline import walk_forward_folds

RANDOM_SEED = 42
# 2026-08-16グリッドサーチ: q=0.8(上位20%)がTop10/30/100すべてでq=0.9より良かった
# （訓練データの正例が増える分、分類器がより自信を持って学習できるため）。
# ランダム基準との相対倍率ではq=0.9の方が高かったが、実際の運用で見るのは
# 生のPrecision@Nなのでq=0.8を採用する。
SOAR_QUANTILE = 0.80
DEFAULT_LGBM_PARAMS = {"n_estimators": 200, "num_leaves": 31, "min_child_samples": 20}

# セグメントごとのハイパーパラメータ。
# competitiveは訓練データが多い（約150万行/フォールド）ため、木を複雑にして
# 学習率を下げる設定がTop10/30/100すべてで改善した（2026-08-16グリッドサーチ）。
# 同じ設定をcollector（約8.5万行/フォールド、データが少ない）に使うと逆に
# 過学習で悪化したため、セグメントごとに分ける。
# n_estimatorsは2026-08-23、訓練データ自身への的中率(ほぼ100%)と未来テストデータ
# への的中率(急騰Top10で40%)の差が大きく明確な過学習だったため500→150に見直した。
# Top10/20/50/100全てで一貫して改善（急騰Top10 58.3%→76.7%）。
SEGMENT_LGBM_PARAMS = {
    "competitive": {"n_estimators": 150, "num_leaves": 63, "min_child_samples": 20, "learning_rate": 0.05},
    "collector": DEFAULT_LGBM_PARAMS,
}


@dataclass
class ClassificationFoldResult:
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    soar_threshold_pct: float
    n_soaring_test: int
    n_test: int
    precision: float
    recall: float
    f1: float


def _fit_classifier(
    train_df: pd.DataFrame, label: pd.Series, *, balanced: bool, lgbm_params: dict | None = None,
    feature_columns: list[str] | None = None,
) -> lgb.LGBMClassifier:
    params = {**DEFAULT_LGBM_PARAMS, **(lgbm_params or {})}
    cols = feature_columns if feature_columns is not None else FEATURE_COLUMNS
    model = lgb.LGBMClassifier(
        random_state=RANDOM_SEED,
        class_weight="balanced" if balanced else None,
        verbose=-1,
        **params,
    )
    model.fit(train_df[cols], label)
    return model


def train_and_evaluate_fold(
    frame: pd.DataFrame, train_start: pd.Timestamp, train_end: pd.Timestamp, test_end: pd.Timestamp, *,
    balanced: bool, soar_quantile: float = SOAR_QUANTILE, fixed_threshold_pct: float | None = None,
    direction: str = "up", return_model: bool = False, lgbm_params: dict | None = None,
):
    """soar_quantile（訓練データの分布に対する相対パーセンタイル、デフォルト）か
    fixed_threshold_pct（例: 10なら「7日後に+10%以上」という絶対%閾値、指定時は
    soar_quantileより優先）のどちらかで「急騰」（direction="up"）または「急落」
    （direction="down"、+10%指定なら「-10%以下」の意味になる）を定義する。
    return_model=Trueなら (result, model) を返す（特徴量重要度の検証用）。"""
    if direction not in ("up", "down"):
        raise ValueError(f'direction must be "up" or "down", got {direction!r}')

    train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(subset=[TARGET_COLUMN])
    test_df = frame[(frame["date"] >= train_end) & (frame["date"] < test_end)].dropna(subset=[TARGET_COLUMN])
    if len(train_df) < 50 or len(test_df) < 10:
        return (None, None) if return_model else None

    target_col = target_column_for_direction(direction)
    if fixed_threshold_pct is not None:
        magnitude = np.log(1 + fixed_threshold_pct / 100)
        threshold = -magnitude if direction == "down" else magnitude
    else:
        # 閾値は訓練データの分布からのみ決める（テストデータを覗き見しない）
        q = (1 - soar_quantile) if direction == "down" else soar_quantile
        threshold = train_df[target_col].quantile(q)

    if direction == "up":
        train_label = (train_df[target_col] >= threshold).astype(int)
        test_label = (test_df[target_col] >= threshold).astype(int)
    else:
        train_label = (train_df[target_col] <= threshold).astype(int)
        test_label = (test_df[target_col] <= threshold).astype(int)

    if train_label.sum() < 5 or test_label.sum() < 3:
        # 急騰/急落サンプルが少なすぎるフォールドは評価が不安定になるためスキップ
        return (None, None) if return_model else None

    model = _fit_classifier(train_df, train_label, balanced=balanced, lgbm_params=lgbm_params)
    pred_label = model.predict(test_df[FEATURE_COLUMNS])

    precision = float(precision_score(test_label, pred_label, zero_division=0))
    recall = float(recall_score(test_label, pred_label, zero_division=0))
    f1 = float(f1_score(test_label, pred_label, zero_division=0))
    threshold_pct = float((np.exp(threshold) - 1) * 100)

    result = ClassificationFoldResult(
        test_start=train_end, test_end=test_end,
        soar_threshold_pct=threshold_pct, n_soaring_test=int(test_label.sum()), n_test=len(test_df),
        precision=precision, recall=recall, f1=f1,
    )
    return (result, model) if return_model else result


def _compute_labels(
    train_df: pd.DataFrame, test_df: pd.DataFrame, *,
    soar_quantile: float, fixed_threshold_pct: float | None, direction: str,
) -> tuple[pd.Series, pd.Series]:
    target_col = target_column_for_direction(direction)
    if fixed_threshold_pct is not None:
        magnitude = np.log(1 + fixed_threshold_pct / 100)
        threshold = -magnitude if direction == "down" else magnitude
    else:
        q = (1 - soar_quantile) if direction == "down" else soar_quantile
        threshold = train_df[target_col].quantile(q)

    if direction == "up":
        return (train_df[target_col] >= threshold).astype(int), (test_df[target_col] >= threshold).astype(int)
    return (train_df[target_col] <= threshold).astype(int), (test_df[target_col] <= threshold).astype(int)


def evaluate_top_n(
    frame: pd.DataFrame, folds: list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]], *,
    direction: str = "up", top_n_values: tuple[int, ...] = (10, 20, 50, 100),
    lgbm_params: dict | None = None, feature_columns: list[str] | None = None, print_result: bool = True,
) -> dict[int, float]:
    """閾値Xで0/1判定するのではなく、分類確率が高い順にトップN件だけを見る
    「確信度ランキング」方式を評価する（以前の分位点回帰の確信度フィルターと同じ発想）。
    実運用で「今日チェックすべき候補」を絞り込む場合はこちらの方が実用的。"""
    cols = feature_columns if feature_columns is not None else FEATURE_COLUMNS
    precision_at_n: dict[int, list[float]] = {n: [] for n in top_n_values}

    for train_start, train_end, test_end in folds:
        train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(subset=[TARGET_COLUMN])
        test_df = frame[(frame["date"] >= train_end) & (frame["date"] < test_end)].dropna(subset=[TARGET_COLUMN])
        if len(train_df) < 50 or len(test_df) < 10:
            continue

        train_label, test_label = _compute_labels(
            train_df, test_df, soar_quantile=SOAR_QUANTILE, fixed_threshold_pct=None, direction=direction
        )
        if train_label.sum() < 5 or test_label.sum() < 3:
            continue

        model = _fit_classifier(
            train_df, train_label, balanced=True, lgbm_params=lgbm_params, feature_columns=cols
        )
        proba = model.predict_proba(test_df[cols])[:, 1]

        order = np.argsort(-proba)
        test_label_sorted = test_label.to_numpy()[order]
        for n in top_n_values:
            if n > len(test_label_sorted):
                continue
            precision_at_n[n].append(float(np.mean(test_label_sorted[:n])))

    result = {n: (float(np.mean(v)) if v else None) for n, v in precision_at_n.items()}
    if print_result:
        label = "急騰" if direction == "up" else "急落"
        print(f"\n--- 確信度トップN方式（{label}、cost-aware） ---")
        for n in top_n_values:
            if result[n] is None:
                print(f"  トップ{n}件: 評価可能なフォールド無し")
            else:
                print(f"  トップ{n}件: Precision@{n}={result[n]:.1%}")
    return result


def run_segment(segment: str, *, balanced: bool) -> None:
    label = "cost-aware" if balanced else "対策無し"
    print(f"\n{'='*20} セグメント: {segment}（{label}） {'='*20}")
    frame = build_training_frame(segment)
    labeled_dates = frame.loc[frame[TARGET_COLUMN].notna(), "date"]
    dates = pd.DatetimeIndex(labeled_dates.unique()).sort_values()
    if len(dates) < 10:
        print("日付のバリエーションが不足しています。スキップします。")
        return

    folds = walk_forward_folds(dates)
    lgbm_params = SEGMENT_LGBM_PARAMS.get(segment)
    results = []
    for train_start, train_end, test_end in folds:
        result = train_and_evaluate_fold(
            frame, train_start, train_end, test_end, balanced=balanced, lgbm_params=lgbm_params
        )
        if result:
            results.append(result)
            print(
                f"  fold [{result.test_start.date()}〜{result.test_end.date()}): "
                f"急騰閾値={result.soar_threshold_pct:+.1f}% "
                f"急騰件数={result.n_soaring_test}/{result.n_test} "
                f"Precision={result.precision:.3f} Recall={result.recall:.3f} F1={result.f1:.3f}"
            )

    if not results:
        print("評価可能なフォールドがありませんでした。")
        return

    print(f"\n=== {segment}（{label}） 全フォールド平均 ===")
    print(f"Precision: {np.mean([r.precision for r in results]):.3f}")
    print(f"Recall: {np.mean([r.recall for r in results]):.3f}")
    print(f"F1: {np.mean([r.f1 for r in results]):.3f}")
    print(f"フォールド数: {len(results)}")


def main() -> None:
    for segment in SEGMENTS:
        run_segment(segment, balanced=False)
        run_segment(segment, balanced=True)


if __name__ == "__main__":
    main()
