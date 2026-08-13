"""
ml/fetch_data.py が保存したParquetから、学習用の特徴量データフレームを組み立てる。

データリーク厳禁: すべての特徴量は「その日時点で分かっている情報」だけから計算する。
目的変数（7日後の対数リターン）を計算するshift(-7)以外は、過去方向のshift/rollingのみ使う。
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).parent / "data"

RARITY_MAP = {"common": 1, "uncommon": 2, "rare": 3, "mythic": 4}

TYPE_CATEGORIES = [
    "Creature",
    "Instant",
    "Sorcery",
    "Enchantment",
    "Artifact",
    "Planeswalker",
    "Land",
    "Battle",
]

# 目的変数の計算に使う先読み日数（1週間後）
TARGET_HORIZON_DAYS = 7


def _parse_cmc(mana_cost: str | None) -> float:
    """mana_cost（例 "{2}{U}{U}"）からマナ総量を概算する。Xは0扱い。カラー/汎用シンボルを
    素朴に数え上げるだけの近似（Scryfallのcmcフィールドは持っていないため）。"""
    if not mana_cost or not isinstance(mana_cost, str):
        return 0.0
    total = 0.0
    for symbol in re.findall(r"\{([^}]+)\}", mana_cost):
        if symbol.isdigit():
            total += float(symbol)
        elif symbol in ("X", "Y", "Z"):
            total += 0.0
        else:
            total += 1.0  # 色マナ・ハイブリッド・Phyrexianマナ等は1として数える
    return total


def build_static_features(static_attrs: pd.DataFrame) -> pd.DataFrame:
    df = static_attrs.copy()
    df["rarity_num"] = df["rarity"].map(RARITY_MAP).fillna(0).astype(int)
    df["cmc"] = df["mana_cost"].map(_parse_cmc)
    df["is_reserved"] = df["is_reserved"].fillna(False).astype(int)
    df["is_serialized"] = df["is_serialized"].fillna(False).astype(int)
    for category in TYPE_CATEGORIES:
        df[f"is_{category.lower()}"] = df["type_line"].fillna("").str.contains(category).astype(int)
    return df[
        ["oracle_id", "rarity_num", "cmc", "is_reserved", "is_serialized"]
        + [f"is_{c.lower()}" for c in TYPE_CATEGORIES]
    ]


def build_time_series_features(price_history: pd.DataFrame) -> pd.DataFrame:
    """オラクル×日付ごとの遅延リターン・移動平均・ボラティリティを計算する。
    全て過去方向のshift/rollingのみで、未来の値は一切参照しない。"""
    df = price_history.sort_values(["oracle_id", "date"]).copy()
    grouped = df.groupby("oracle_id")["jpy_est"]

    df["log_price"] = np.log(df["jpy_est"])
    df["return_1d"] = grouped.pct_change(1)
    df["return_7d"] = grouped.pct_change(7)
    df["return_30d"] = grouped.pct_change(30)
    df["ma_7d"] = grouped.transform(lambda s: s.rolling(7, min_periods=3).mean())
    df["ma_30d"] = grouped.transform(lambda s: s.rolling(30, min_periods=7).mean())
    df["price_vs_ma7d"] = df["jpy_est"] / df["ma_7d"] - 1

    daily_return = grouped.pct_change(1)
    df["volatility_7d"] = daily_return.groupby(df["oracle_id"]).transform(
        lambda s: s.rolling(7, min_periods=3).std()
    )

    # 目的変数: 7日後の対数リターン（先読みなので学習直前に必ず末尾を切り捨てる側で使う）
    future_price = grouped.shift(-TARGET_HORIZON_DAYS)
    df["log_return_7d"] = np.log(future_price / df["jpy_est"])

    return df


def build_usage_features(usage_stats: pd.DataFrame) -> pd.DataFrame:
    """フォーマット横断で最大の採用率と、直近の変化量を1オラクル1行に集約する
    （フォーマット別の細かい内訳はv1では持たず、まず「一番使われているフォーマットでの
    採用率」だけを特徴量にする）。"""
    if usage_stats.empty:
        return pd.DataFrame(columns=["oracle_id", "date", "usage_rate_max", "usage_rate_change"])

    df = usage_stats.rename(columns={"calculated_at": "date"}).copy()
    latest_per_format = df.sort_values("date").groupby(["oracle_id", "format"])
    df["usage_rate_change"] = latest_per_format["usage_rate"].diff()

    agg = (
        df.groupby(["oracle_id", "date"])
        .agg(usage_rate_max=("usage_rate", "max"), usage_rate_change=("usage_rate_change", "sum"))
        .reset_index()
    )
    return agg


# 候補カードの絞り込み閾値（円）。再録禁止リスト該当・シリアル番号入りはこの価格を問わず候補に含む。
# 実データ分布（p90≈995円、p95≈2043円、p99≈7574円）から、上位3%程度のラインとして設定した。
CANDIDATE_PRICE_THRESHOLD_JPY = 3000


def build_training_frame() -> pd.DataFrame:
    price_history = pd.read_parquet(DATA_DIR / "price_history.parquet")
    usage_stats = pd.read_parquet(DATA_DIR / "usage_stats.parquet")
    static_attrs = pd.read_parquet(DATA_DIR / "static_attrs.parquet")

    ts = build_time_series_features(price_history)
    usage = build_usage_features(usage_stats)
    static = build_static_features(static_attrs)

    frame = ts.merge(usage, on=["oracle_id", "date"], how="left")
    frame = frame.merge(static, on="oracle_id", how="left")

    # 採用率データが無い日（フォーマットで使われていないカード）は0扱い
    frame["usage_rate_max"] = frame["usage_rate_max"].fillna(0)
    frame["usage_rate_change"] = frame["usage_rate_change"].fillna(0)
    frame["is_reserved"] = frame["is_reserved"].fillna(0).astype(int)
    frame["is_serialized"] = frame["is_serialized"].fillna(0).astype(int)

    # 移動平均・ボラティリティが計算できない立ち上がり期間の行は学習から除外する
    frame = frame.dropna(subset=["ma_30d", "volatility_7d"])

    # 候補カード絞り込み: 再録禁止 or シリアル番号入り or 一定額以上の価格（その時点の価格で判定）。
    # デッキ採用回数は基準に含めない（デッキで使われているカードと重複する上、時代が変わると
    # ノイズになりやすいため）。
    is_candidate = (
        (frame["is_reserved"] == 1)
        | (frame["is_serialized"] == 1)
        | (frame["jpy_est"] >= CANDIDATE_PRICE_THRESHOLD_JPY)
    )
    frame = frame[is_candidate]
    return frame


FEATURE_COLUMNS = [
    "log_price",
    "return_1d",
    "return_7d",
    "return_30d",
    "ma_7d",
    "ma_30d",
    "price_vs_ma7d",
    "volatility_7d",
    "usage_rate_max",
    "usage_rate_change",
    "rarity_num",
    "cmc",
    "is_reserved",
    "is_serialized",
] + [f"is_{c.lower()}" for c in TYPE_CATEGORIES]

TARGET_COLUMN = "log_return_7d"


if __name__ == "__main__":
    frame = build_training_frame()
    print(f"特徴量データフレーム: {len(frame)}行 x {len(frame.columns)}列")
    print(f"目的変数(log_return_7d)が計算できる行: {frame[TARGET_COLUMN].notna().sum()}行")
    frame.to_parquet(DATA_DIR / "training_frame.parquet", index=False)
