"""
Learning to Rank（LightGBMのobjective="lambdarank"）による価格予測。

これまでの回帰（train_baseline.py）・分類（train_classification.py）は、
「7日後の変動率を当てる」「閾値を超えるか」という間接的な代理目標を最適化していた。
しかし実際にサイトで使うのは「その日の全候補の中でのTop100順位」であり、
順位そのものを直接最適化する方が実用目的に合っている（2026-08-16、ユーザー指摘）。

日付ごとに「その日の全候補カード」を1グループとして、グループ内での相対順位を
LambdaRankで直接学習する。評価はPrecision@N（train_classification.pyの
evaluate_top_nと同じ発想）で行い、回帰・分類の確信度ランキング方式と直接比較する。

relevance（LightGBMランカーが要求する非負整数の関連度ラベル）は、
log_return_7dを各フォールドの訓練データの分布から動的に分位点でビン分割して作る
（絶対%閾値だとセグメント間でスケールが違いすぎるため、分位点ベースが妥当）。

実行: python ml/train_ranking.py
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from features import FEATURE_COLUMNS, SEGMENTS, TARGET_COLUMN, build_training_frame
from train_baseline import RANDOM_SEED, walk_forward_folds

N_RELEVANCE_LEVELS = 10
TOP_N_VALUES = (10, 20, 30, 50, 100)


def _make_relevance(train_target: pd.Series, values: pd.Series) -> np.ndarray:
    """train_targetの分位点で境界を作り、valuesをN_RELEVANCE_LEVELS段階の
    整数関連度に変換する（値が高いほど関連度が高い＝上位に来るべき）。"""
    bin_edges = np.unique(train_target.quantile(np.linspace(0, 1, N_RELEVANCE_LEVELS + 1)).to_numpy())
    if len(bin_edges) < 3:
        # 分布が偏りすぎてビンを作れない場合は全て同じ関連度にする
        return np.zeros(len(values), dtype=int)
    relevance = np.digitize(values.to_numpy(), bin_edges[1:-1], right=True)
    return relevance.astype(int)


def train_and_evaluate_fold(
    frame: pd.DataFrame, train_start: pd.Timestamp, train_end: pd.Timestamp, test_end: pd.Timestamp
) -> dict | None:
    train_df = frame[(frame["date"] >= train_start) & (frame["date"] < train_end)].dropna(subset=[TARGET_COLUMN])
    test_df = frame[(frame["date"] >= train_end) & (frame["date"] < test_end)].dropna(subset=[TARGET_COLUMN])
    if len(train_df) < 50 or len(test_df) < 10:
        return None

    # LightGBMランカーはグループ順にソートされたデータと、各グループのサイズ配列を要求する
    train_df = train_df.sort_values("date")
    test_df = test_df.sort_values("date")
    train_group_sizes = train_df.groupby("date").size().to_numpy()
    test_group_sizes = test_df.groupby("date").size().to_numpy()

    train_relevance = _make_relevance(train_df[TARGET_COLUMN], train_df[TARGET_COLUMN])

    model = lgb.LGBMRanker(
        objective="lambdarank",
        random_state=RANDOM_SEED,
        n_estimators=200,
        num_leaves=31,
        min_child_samples=20,
        # デフォルト30だとNDCG@30近辺しか意識しないため、Top100まで見たい今回の用途に
        # 合わせて引き上げる（2026-08-16、WEB検索で判明したチューニング指針）。
        lambdarank_truncation_level=100,
        # 不均衡データ（グループごとの候補数が数千〜数十万と大きくばらつく）向けの
        # 正規化。デフォルトでTrueのはずだが明示する。
        lambdarank_norm=True,
        verbose=-1,
    )
    model.fit(train_df[FEATURE_COLUMNS], train_relevance, group=train_group_sizes)

    test_df = test_df.copy()
    test_df["pred_score"] = model.predict(test_df[FEATURE_COLUMNS])

    # 日付ごとに独立してTop N件を取り、実際の急騰（上位10%分位点、train基準）だった
    # 割合をPrecision@Nとして計算する（train_classification.evaluate_top_nと同じ定義）
    soar_threshold = train_df[TARGET_COLUMN].quantile(0.9)
    test_df["is_soaring"] = (test_df[TARGET_COLUMN] >= soar_threshold).astype(int)

    precision_at_n = {n: [] for n in TOP_N_VALUES}
    for _, day_df in test_df.groupby("date"):
        day_sorted = day_df.sort_values("pred_score", ascending=False)
        for n in TOP_N_VALUES:
            if len(day_sorted) < n:
                continue
            precision_at_n[n].append(day_sorted["is_soaring"].head(n).mean())

    return {n: float(np.mean(v)) if v else None for n, v in precision_at_n.items()}


def run_segment(segment: str) -> None:
    print(f"\n{'='*20} セグメント: {segment}（Learning to Rank） {'='*20}")
    frame = build_training_frame(segment)
    dates = pd.DatetimeIndex(frame.loc[frame[TARGET_COLUMN].notna(), "date"].unique()).sort_values()
    if len(dates) < 10:
        print("日付のバリエーションが不足しています。スキップします。")
        return

    folds = walk_forward_folds(dates)
    fold_results = []
    for train_start, train_end, test_end in folds:
        result = train_and_evaluate_fold(frame, train_start, train_end, test_end)
        if result:
            fold_results.append(result)
            parts = " ".join(f"P@{n}={v:.1%}" if v is not None else f"P@{n}=N/A" for n, v in result.items())
            print(f"  fold: {parts}")

    if not fold_results:
        print("評価可能なフォールドがありませんでした。")
        return

    print(f"\n=== {segment} 全フォールド平均（Learning to Rank） ===")
    for n in TOP_N_VALUES:
        values = [r[n] for r in fold_results if r[n] is not None]
        if values:
            print(f"  Precision@{n}: {np.mean(values):.1%}")


def main() -> None:
    for segment in SEGMENTS:
        run_segment(segment)


if __name__ == "__main__":
    main()
