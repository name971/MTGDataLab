"""
ml/fetch_data.py が保存したParquetから、学習用の特徴量データフレームを組み立てる。

データリーク厳禁: すべての特徴量は「その日時点で分かっている情報」だけから計算する。
目的変数（7日以内のどこかで到達した最大の対数リターン、log_return_7d_max）を計算する
shift(-1)〜shift(-7)以外は、過去方向のshift/rollingのみ使う。

【2026-08-27、目的変数をlog_return_7dからlog_return_7d_maxへ変更】
「7日後ちょうどの瞬間値」は、日3で跳ねて日7には落ち着いているような実際に当てたい
値動きを取りこぼすノイズの多い目的変数だった（ユーザー提案の検証で判明）。
「7日以内のどこかで一度でも閾値を超えたか」に変えたところ、分類モデルのF1が
競技勢0.077→0.273（対策無し）、コレクター勢0.126→0.219と大幅に改善した
（docs/price-prediction-plan.md参照）。UIの説明文（「7日以内に一定以上値上がり
する確率」）とも整合する。log_return_7dは回帰の目的変数比較用に残してある。
"""

from __future__ import annotations

import re
from functools import lru_cache
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

# 目的変数の計算に使う先読み日数（1週間後）。3日後で試したところ的中率が悪化した
# （2026-08-16、docs/price-prediction-plan.md参照）ため7日のまま。
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


def build_time_series_features(price_history: pd.DataFrame, id_column: str = "oracle_id") -> pd.DataFrame:
    """id_column（既定はoracle_id）×日付ごとの遅延リターン・移動平均・ボラティリティを
    計算する。全て過去方向のshift/rollingのみで、未来の値は一切参照しない。
    collectorセグメント（プリント単位で追う、2026-08-22）ではid_column="scryfall_id"
    で呼ぶ。"""
    df = price_history.sort_values([id_column, "date"]).copy()
    grouped = df.groupby(id_column)["jpy_est"]

    df["log_price"] = np.log(df["jpy_est"])
    df["return_1d"] = grouped.pct_change(1)
    # Pawlicki et al.では価格・採用率・売上いずれも3日差分が最も予測に効いていた
    # （採用率側はusage_rate_change_3dで既に反映済み。価格側も同じ知見で追加する）
    df["return_3d"] = grouped.pct_change(3)
    df["return_7d"] = grouped.pct_change(7)
    df["return_30d"] = grouped.pct_change(30)
    df["ma_7d"] = grouped.transform(lambda s: s.rolling(7, min_periods=3).mean())
    df["ma_30d"] = grouped.transform(lambda s: s.rolling(30, min_periods=7).mean())
    df["price_vs_ma7d"] = df["jpy_est"] / df["ma_7d"] - 1

    daily_return = grouped.pct_change(1)
    df["volatility_7d"] = daily_return.groupby(df[id_column]).transform(
        lambda s: s.rolling(7, min_periods=3).std()
    )

    # 目的変数: 7日後の対数リターン（先読みなので学習直前に必ず末尾を切り捨てる側で使う）
    future_price = grouped.shift(-TARGET_HORIZON_DAYS)
    df["log_return_7d"] = np.log(future_price / df["jpy_est"])

    # 目的変数（ablation用、2026-08-27）: 「7日後ちょうど」ではなく「7日以内のどこかで
    # 一度でも閾値を超えたか」。ユーザー提案: 実運用で知りたいのは「ちょうど7日後の
    # 価格」ではなく「その週のうちに一度でも跳ねたか」のはずなので、7日後の1点よりも
    # 有効かもしれないという仮説の検証用。1〜7日後それぞれの対数リターンの最大値を取る
    # （下落側はmin値、is_up=Falseで使う想定）。
    future_log_returns = [np.log(grouped.shift(-h) / df["jpy_est"]) for h in range(1, TARGET_HORIZON_DAYS + 1)]
    # .max(axis=1)はデフォルトでNaNを無視するため、末尾付近の行（未来7日分の一部しか
    # 無い）でも「見えている範囲だけの最大値」を返してしまい、本来NaN（先読み不能）に
    # すべき行を誤って学習可能な行として扱ってしまう。7日分全て揃っている行だけを対象にする。
    future_returns_df = pd.concat(future_log_returns, axis=1)
    complete_window = future_returns_df.notna().all(axis=1)
    df["log_return_7d_max"] = future_returns_df.max(axis=1).where(complete_window)
    df["log_return_7d_min"] = future_returns_df.min(axis=1).where(complete_window)

    return df


@lru_cache(maxsize=1)
def _set_return_aggregates() -> pd.DataFrame:
    """全カード（候補絞り込み前）のprice_history全量から、セット×日付ごとの
    return_7dの合計・件数を集計する（「他カードとの連動」を測るには、絞り込み後の
    数枚だけでなく市場全体の同セットカードを母数にしたいため）。segmentごとに
    重複計算しないようlru_cacheでプロセス内キャッシュする。"""
    path = DATA_DIR / "scryfall_set_index.ndjson"
    if not path.exists():
        return pd.DataFrame(columns=["set_code", "date", "set_return_sum", "set_return_count"])

    price_history = pd.read_parquet(DATA_DIR / "price_history.parquet")
    set_index = pd.read_json(path, lines=True)
    price_history = price_history.merge(set_index, on="scryfall_id", how="left")
    price_history = price_history.sort_values(["oracle_id", "date"])
    price_history["return_7d"] = price_history.groupby("oracle_id")["jpy_est"].pct_change(7)

    valid = price_history.dropna(subset=["set_code", "return_7d"])
    agg = valid.groupby(["set_code", "date"])["return_7d"].agg(
        set_return_sum="sum", set_return_count="count"
    ).reset_index()
    return agg


def build_set_features(ts: pd.DataFrame) -> pd.DataFrame:
    """同じセットの他カード（自分を除く）の7日リターン平均（set_avg_return_7d）。
    セット全体が再評価されたり新コンボが見つかったりすると、そのセット内の関連カードが
    連動して動く性質を捉える狙い。市場全体（候補絞り込み前）を母数にした
    _set_return_aggregates()を使い、自分自身の寄与を除いて平均する
    （leave-one-out、同日の他カードのreturn_7dは全て「その時点で既知の情報」なので
    データリークにはならない）。"""
    empty_columns = ["oracle_id", "date", "set_avg_return_7d"]
    path = DATA_DIR / "scryfall_set_index.ndjson"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    set_index = pd.read_json(path, lines=True)
    merged = ts[["oracle_id", "date", "scryfall_id", "return_7d"]].merge(set_index, on="scryfall_id", how="left")
    merged = merged.merge(_set_return_aggregates(), on=["set_code", "date"], how="left")

    has_peers = merged["set_return_count"] > 1
    merged["set_avg_return_7d"] = np.where(
        has_peers,
        (merged["set_return_sum"] - merged["return_7d"].fillna(0)) / (merged["set_return_count"] - 1),
        np.nan,
    )
    return merged[["oracle_id", "date", "set_avg_return_7d"]]


@lru_cache(maxsize=1)
def _archetype_return_aggregates() -> pd.DataFrame:
    """全カード（候補絞り込み前）のprice_history全量から、アーキタイプ×日付ごとの
    return_7dの合計・件数を集計する（set_avg_return_7dと同じ発想。セットと違い
    1枚のカードが複数アーキタイプで使われうる多対多の関係なので、_oracle_archetype_map()
    で「その日、そのオラクルが最も多く使われていたアーキタイプ」に代表させてから
    集計する）。"""
    empty = pd.DataFrame(columns=["archetype", "date", "archetype_return_sum", "archetype_return_count"])
    archetype_map = _oracle_archetype_map()
    if archetype_map.empty:
        return empty

    price_history = pd.read_parquet(DATA_DIR / "price_history.parquet")
    price_history = price_history.sort_values(["oracle_id", "date"])
    price_history["return_7d"] = price_history.groupby("oracle_id")["jpy_est"].pct_change(7)

    merged = price_history.merge(archetype_map, on=["oracle_id", "date"], how="inner")
    valid = merged.dropna(subset=["archetype", "return_7d"])
    agg = valid.groupby(["archetype", "date"])["return_7d"].agg(
        archetype_return_sum="sum", archetype_return_count="count"
    ).reset_index()
    return agg


@lru_cache(maxsize=1)
def _oracle_archetype_map() -> pd.DataFrame:
    """ml/build_archetype_history.tsが書き出したarchetype_history.ndjson（1行=
    1デッキ内の1オラクル×そのデッキのアーキタイプ）から、(oracle_id, date)ごとに
    「その日、そのオラクルが最も多く使われていたアーキタイプ」（最頻値）を1つ選ぶ。
    1枚のカードが複数アーキタイプ・複数デッキで使われうる多対多の関係を、
    日単位で単純化して代表アーキタイプ1つに丸める簡易実装（2026-08-16、
    ユーザー指摘「簡易的に試してみよう」）。"""
    empty = pd.DataFrame(columns=["oracle_id", "date", "archetype"])
    path = DATA_DIR / "archetype_history.ndjson"
    if not path.exists():
        return empty

    raw = pd.read_json(path, lines=True)
    raw = raw.rename(columns={"event_date": "date"})
    raw["date"] = pd.to_datetime(raw["date"])

    counts = raw.groupby(["oracle_id", "date", "archetype"]).size().reset_index(name="n")
    # 同数タイの場合はgroupby.idxmaxが先頭（アーキタイプ名の昇順に依存）を返すが、
    # どれを選んでも「同程度使われている」という点で大差は無いため許容する
    idx = counts.groupby(["oracle_id", "date"])["n"].idxmax()
    return counts.loc[idx, ["oracle_id", "date", "archetype"]]


def build_archetype_features(ts: pd.DataFrame) -> pd.DataFrame:
    """同じアーキタイプの他カード（自分を除く）の7日リターン平均
    （archetype_avg_return_7d）。set_avg_return_7dのアーキタイプ版。サイトで実際に
    使っているBadaro/MTGOFormatDataルール+archetypeEngine.tsをそのまま流用して
    分類したデータが元（独自の分類器は作らない、2026-08-16ユーザー指摘）。"""
    empty_columns = ["oracle_id", "date", "archetype_avg_return_7d"]
    archetype_map = _oracle_archetype_map()
    if archetype_map.empty:
        return pd.DataFrame(columns=empty_columns)

    merged = ts[["oracle_id", "date", "return_7d"]].merge(archetype_map, on=["oracle_id", "date"], how="left")
    merged = merged.merge(_archetype_return_aggregates(), on=["archetype", "date"], how="left")

    has_peers = merged["archetype_return_count"] > 1
    merged["archetype_avg_return_7d"] = np.where(
        has_peers,
        (merged["archetype_return_sum"] - merged["return_7d"].fillna(0)) / (merged["archetype_return_count"] - 1),
        np.nan,
    )
    return merged[["oracle_id", "date", "archetype_avg_return_7d"]]


def build_reprint_features(price_dates: pd.DataFrame) -> pd.DataFrame:
    """ml/build_reprint_history.mjsが書き出したreprint_history.ndjson（1行=1オラクルの
    1発売日、同日複数バリエーションは重複除去済み）から、価格データフレームの各
    (oracle_id, date)時点での reprint_count（累計再録回数、初版は含まない）と
    days_since_last_reprint（直近再録からの経過日数、まだ再録が無ければNaN）を
    merge_asofで点時点計算する。未来の発売日を参照しないためdirection="backward"。"""
    empty_columns = ["oracle_id", "date", "reprint_count", "days_since_last_reprint", "days_since_release"]
    path = DATA_DIR / "reprint_history.ndjson"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    reprints = pd.read_json(path, lines=True)
    reprints["release_date"] = pd.to_datetime(reprints["release_date"])
    # release_rankはオラクル単位の累積カウントだが、merge_asof(by=...)は「on」列が
    # グループ内ではなく全体でソート済みであることを要求するため、rank計算後に
    # release_date一本でソートし直す。
    reprints = reprints.sort_values(["oracle_id", "release_date"])
    reprints["release_rank"] = reprints.groupby("oracle_id").cumcount() + 1
    reprints = reprints.sort_values("release_date")

    dates = price_dates.sort_values("date")
    merged = pd.merge_asof(
        dates,
        reprints[["oracle_id", "release_date", "release_rank"]],
        left_on="date",
        right_on="release_date",
        by="oracle_id",
        direction="backward",
    )
    merged["reprint_count"] = (merged["release_rank"] - 1).clip(lower=0)
    merged["days_since_last_reprint"] = np.where(
        merged["release_rank"] > 1, (merged["date"] - merged["release_date"]).dt.days, np.nan
    )
    # 初版（release_rank==1）も含めた「直近の発売（初版 or 再録）からの経過日数」。
    # 予約価格は供給が絞られた状態で需要が高いため発売直後は下がりやすい、という
    # 減衰効果は再録だけでなく初版にも当てはまるが、days_since_last_reprintは
    # release_rank==1をNaNにしていたため初版の新カードにはこの情報が一切無かった
    # （2026-08-16に気付いて追加）。
    merged["days_since_release"] = (merged["date"] - merged["release_date"]).dt.days
    return merged[["oracle_id", "date", "reprint_count", "days_since_last_reprint", "days_since_release"]]


def build_banned_feature(price_dates: pd.DataFrame) -> pd.DataFrame:
    """ml/build_banned_history.mjsが書き出したbanned_history.ndjson（禁止のみ、制限は
    含まない）から、各(oracle_id, date)時点で「追跡対象のいずれかのフォーマットで
    既に禁止済みか」（is_banned）と「直近の禁止発表からの経過日数」
    （days_since_ban、reprint系と同じ減衰効果を捉える狙い。まだ禁止されていなければ
    NaN）を計算する。フォーマットをまたいだ最初の禁止日をそのオラクルの基準にする
    （is_banned/days_since_banはフォーマット非依存の1オラクル1系列のため）。"""
    empty_columns = ["oracle_id", "date", "is_banned", "days_since_ban"]
    path = DATA_DIR / "banned_history.ndjson"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    banned = pd.read_json(path, lines=True)
    banned["ban_date"] = pd.to_datetime(banned["ban_date"])
    earliest_ban = banned.groupby("oracle_id")["ban_date"].min().reset_index()

    merged = price_dates.merge(earliest_ban, on="oracle_id", how="left")
    merged["is_banned"] = (merged["date"] >= merged["ban_date"]).fillna(False).astype(int)
    merged["days_since_ban"] = np.where(
        merged["is_banned"] == 1, (merged["date"] - merged["ban_date"]).dt.days, np.nan
    )
    return merged[["oracle_id", "date", "is_banned", "days_since_ban"]]


# ml/build_standard_rotation.mjsのROTATION_YEARSと合わせる
ROTATION_YEARS = 3


def build_standard_rotation_feature(price_dates: pd.DataFrame) -> pd.DataFrame:
    """ml/build_standard_rotation.mjsが書き出したstandard_rotation.ndjsonから、
    各(oracle_id, date)時点での「Standardローテーションまでの残り日数」
    （days_until_rotation）を計算する。Pawlicki et al.（Stanford CS229, 2014）の
    特徴量「Days until card loses tournament legality」着想。ローテーション日は
    近似値（現在Standard合法な最も古いプリントの発売日+3年）なので、正確な日数
    ではなく「古いセットほど近い」という順序関係の目安として使う。Standard対象外
    のカード（Legacy/Vintage/Commander専有の定番カード等）はNaN（意味のある欠損、
    ローテーションという概念が存在しないカードなので0埋めしない）。"""
    empty_columns = ["oracle_id", "date", "days_until_rotation"]
    path = DATA_DIR / "standard_rotation.ndjson"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    rotation = pd.read_json(path, lines=True)
    rotation["rotation_date"] = pd.to_datetime(rotation["rotation_date"])

    merged = price_dates.merge(rotation, on="oracle_id", how="left")
    merged["days_until_rotation"] = (merged["rotation_date"] - merged["date"]).dt.days
    # オラクル単位で結合しているため、そのカードの過去の別プリント時代の価格行
    # （現在Standard合法なプリントが出るずっと前の日付）にまで現在のローテーション日を
    # 当てはめてしまい、-8000日を超えるような異常値が発生する。ローテーション周期
    # （3年）を大きく外れる値は無意味なのでNaNにする。
    max_valid_days = ROTATION_YEARS * 365 + 366  # 閏年バッファ
    out_of_range = (merged["days_until_rotation"] < -30) | (merged["days_until_rotation"] > max_valid_days)
    merged.loc[out_of_range, "days_until_rotation"] = np.nan
    return merged[["oracle_id", "date", "days_until_rotation"]]


USAGE_CHANGE_LAG_DAYS = (1, 3, 6)


def build_usage_features(usage_stats: pd.DataFrame) -> pd.DataFrame:
    """フォーマット横断でプールした採用率と、その1/3/6日前比を1オラクル1行に集約する。
    Pawlicki et al.（Stanford CS229, 2014）の採用率は「D-6〜D日に使われた回数 / 同期間に
    使われた全カードの回数」で、特定フォーマットに絞らず全デッキをプールした比率になって
    いる（フォーマット別の内訳という概念が無い）。それに合わせ、v1で使っていた「一番使われて
    いるフォーマットでの採用率（max）」ではなく、deck_sample_size（フォーマットごとの集計
    デッキ数）を重みにした加重平均でフォーマット横断にプールする
    （raw使用回数はcard_usage_statsに残っていないため、usage_rate×deck_sample_sizeを
    近似的な使用回数として扱う）。3日差分が単独で最も予測に効いていた
    （src/lib/dbTrendingRanking.tsのUSAGE_WEIGHT設計でも同じ知見を採用済み）ため、
    1日前比だけでなく3日・6日前比も特徴量に加える。"""
    empty_columns = ["oracle_id", "date", "usage_rate_max"] + [
        f"usage_rate_change_{d}d" for d in USAGE_CHANGE_LAG_DAYS
    ]
    if usage_stats.empty:
        return pd.DataFrame(columns=empty_columns)

    df = usage_stats.rename(columns={"calculated_at": "date"}).copy()

    # オラクル×日付で、フォーマット横断の加重平均採用率にプールしてから、
    # その系列に対して暦日ベースで1/3/6日前比を計算する（フォーマットをまたいだ差分は
    # 意味が無いため）。列名はusage_rate_maxのままだが、中身は最大値ではなくプール済み値。
    df["_weighted"] = df["usage_rate"] * df["deck_sample_size"]
    grouped = df.groupby(["oracle_id", "date"])
    agg = grouped["_weighted"].sum().div(grouped["deck_sample_size"].sum()).reset_index(
        name="usage_rate_max"
    )
    agg = agg.sort_values(["oracle_id", "date"])

    # card_usage_statsは日次で計算されるため基本的に連続しているはずだが、念のため
    # 実際の日付間隔を見てから差分を取る（pandasのgroupby.diff(periods=N)は行数ベースの
    # ずれで、日付が欠けているとNずれた別の日と比較してしまうため使わない）。
    pivot = agg.pivot(index="date", columns="oracle_id", values="usage_rate_max").sort_index()
    for lag_days in USAGE_CHANGE_LAG_DAYS:
        shifted = pivot.reindex(pivot.index - pd.Timedelta(days=lag_days), method=None)
        shifted.index = pivot.index
        change = pivot - shifted
        change_long = change.stack().rename(f"usage_rate_change_{lag_days}d").reset_index()
        agg = agg.merge(change_long, on=["date", "oracle_id"], how="left")

    return agg


def build_win_rate_features() -> pd.DataFrame:
    """ml/build_usage_history_from_tournaments.pyが書き出したwin_rate_history.parquet
    （win_rate_avg_7d: そのカードを採用したデッキの平均勝率、avg_copies_7d: 平均投入枚数、
    いずれもフォーマット横断・直近7日ローリング窓）をそのまま返す。「勝っているデッキで
    使われているカードは今後採用率が上がりやすい」「4枚フル投入のコア戦略カードと
    1枚だけのタッチ採用を区別する」という2つの着想（2026-08-16、ユーザー指摘）。"""
    empty_columns = ["oracle_id", "date", "win_rate_avg_7d", "avg_copies_7d"]
    path = DATA_DIR / "win_rate_history.parquet"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    df = pd.read_parquet(path).rename(columns={"calculated_at": "date"})
    return df[["oracle_id", "date", "win_rate_avg_7d", "avg_copies_7d"]]


def build_sideboard_usage_features() -> pd.DataFrame:
    """ml/build_usage_history_from_tournaments.pyが書き出したsideboard_usage_stats.parquet
    （usage_stats.parquetと同じ定義・スキーマだがboard=="side"のみ）から、
    build_usage_features()と同じロジックでフォーマット横断プール採用率を計算する。
    列名はsideboard_プレフィックスを付けてメインボード側と衝突しないようにする。
    サイドボードは対策カードだけでなく汎用的な回答カードも多く、メインボードから
    除外すると需要シグナルが完全に見えなくなるため（2026-08-16、ユーザー指摘）、
    別特徴量として追加する。"""
    empty_columns = ["oracle_id", "date", "sideboard_usage_rate_max"] + [
        f"sideboard_usage_rate_change_{d}d" for d in USAGE_CHANGE_LAG_DAYS
    ]
    path = DATA_DIR / "sideboard_usage_stats.parquet"
    if not path.exists():
        return pd.DataFrame(columns=empty_columns)

    sideboard_stats = pd.read_parquet(path)
    result = build_usage_features(sideboard_stats)
    rename_map = {"usage_rate_max": "sideboard_usage_rate_max"} | {
        f"usage_rate_change_{d}d": f"sideboard_usage_rate_change_{d}d" for d in USAGE_CHANGE_LAG_DAYS
    }
    return result.rename(columns=rename_map)[["oracle_id", "date"] + list(rename_map.values())]


# 安すぎるカード（バルク）は数円の変動が%表示だと誇張されノイズになるため候補から除く。
CANDIDATE_MIN_PRICE_JPY = 300

SEGMENTS = ("competitive", "collector")

# 「安いプリントは別にあるのに特定版だけ高い」というコレクター需要のパターンを
# 判定する閾値（2026-08-22）。is_reserved/is_serialized（発行ルール）だけでは
# 実際のプレミアムプリント（showcase/borderless/foil-etched等）の大半を取りこぼす
# ことが実データで判明したため、価格差ベースの判定を追加した。
# 最高値プリントがこの金額未満（バルク近辺）だと比率が誇張されノイズになるため、
# 金額の下限も併用する（実データで確認したところ、ある程度の金額があれば比率は
# ほぼ自然に5倍を超えていた＝比率自体より金額の下限が実質的なフィルターとして効く）。
PREMIUM_PRINT_MIN_RATIO = 5
PREMIUM_PRINT_MIN_JPY = 3000


def identify_premium_prints(print_current_prices: pd.DataFrame, usd_to_jpy_rate: float) -> set[str]:
    """card_print_current_prices（今日時点のプリント単位価格）から、そのオラクルの
    中で「特定版だけ価格が突出している」プリント（scryfall_id）を判定する。
    競技実績の有無は問わない（デュアルランドのように競技定番でも旧枠オリジナルだけ
    コレクター価格が付くケースがあるため）。"""
    if print_current_prices.empty:
        return set()
    df = print_current_prices.copy()
    df["priciest"] = df[["usd", "usd_foil"]].max(axis=1)
    df["cheapest"] = df[["usd", "usd_foil"]].min(axis=1)
    min_by_oracle = df.groupby("oracle_id")["cheapest"].transform("min")
    priciest_jpy = df["priciest"] * usd_to_jpy_rate
    is_premium = (priciest_jpy >= PREMIUM_PRINT_MIN_JPY) & (
        df["priciest"] >= min_by_oracle * PREMIUM_PRINT_MIN_RATIO
    )
    return set(df.loc[is_premium, "scryfall_id"])


def _build_competitive_frame(static_attrs: pd.DataFrame, usage_stats: pd.DataFrame) -> pd.DataFrame:
    """トーナメントで実際に使われた実績がある（card_usage_statsに一度でも登場した）
    オラクル。競技勢は非Foil・最安値を買う傾向があるため、jpy_est（非Foil最安、
    compute-cheapest-price-snapshots.mjs参照）をそのまま使う。usage_statsは直近60日分
    しか無いため「一度でも登場したオラクル」をcompetitiveとして扱い、その上で
    price_historyの全期間（約2.5年）を学習対象に含める。"""
    price_history = pd.read_parquet(DATA_DIR / "price_history.parquet")
    usage = build_usage_features(usage_stats)
    static = build_static_features(static_attrs)

    played_oracle_ids = set(usage_stats["oracle_id"].unique()) if not usage_stats.empty else set()
    price_history = price_history[price_history["oracle_id"].isin(played_oracle_ids)].copy()

    ts = build_time_series_features(price_history)

    reprint = build_reprint_features(ts[["oracle_id", "date"]])
    banned = build_banned_feature(ts[["oracle_id", "date"]])
    set_features = build_set_features(ts)
    win_rate = build_win_rate_features()
    sideboard_usage = build_sideboard_usage_features()
    rotation = build_standard_rotation_feature(ts[["oracle_id", "date"]])
    archetype_features = build_archetype_features(ts)

    frame = ts.merge(usage, on=["oracle_id", "date"], how="left")
    frame = frame.merge(static, on="oracle_id", how="left")
    frame = frame.merge(reprint, on=["oracle_id", "date"], how="left")
    frame = frame.merge(banned, on=["oracle_id", "date"], how="left")
    frame = frame.merge(set_features, on=["oracle_id", "date"], how="left")
    frame = frame.merge(win_rate, on=["oracle_id", "date"], how="left")
    frame = frame.merge(sideboard_usage, on=["oracle_id", "date"], how="left")
    frame = frame.merge(rotation, on=["oracle_id", "date"], how="left")
    frame = frame.merge(archetype_features, on=["oracle_id", "date"], how="left")
    return frame


def _build_collector_frame(static_attrs: pd.DataFrame) -> pd.DataFrame:
    """コレクター需要はプリント単位（scryfall_id）で追う（2026-08-22、オラクル単位の
    最安値だけ見ていると「安いプリントは別にあるのに特定版だけ高い」というコレクター
    需要のパターン自体が見えなくなる問題が判明したため）。対象プリントは次のOR条件:
      - 再録禁止 or シリアル番号入りのオラクルの全プリント（発行ルール上コレクター
        カード確定、価格差の有無を問わない）
      - どのオラクルに属していても、そのオラクルの中で価格が突出しているプリント
        （identify_premium_prints、showcase/borderless/foil-etched等の特殊仕上げ版が
        典型例）。competitiveとの重複を許容する（デュアルランドのように競技定番でも
        旧枠オリジナルだけコレクター価格が付くケースがあるため、以前は競技実績優先で
        除外していたが、そのままだと最安値のjpy_estしか見ずプレミアム版の値動きを
        見逃していた）。
    コレクターが実際に買うのはFoilや希少プリントなので、そのプリントのusd_foilを
    優先し（無ければusd＝非Foルを代用）、日次為替レートでJPY換算する。
    採用率・アーキタイプ・勝率等（回帰でもcollectorは重要度0だったことを確認済み、
    docs/price-prediction-plan.md参照）は計算しない。"""
    print_current_prices = pd.read_parquet(DATA_DIR / "print_current_prices.parquet")
    print_history = pd.read_parquet(DATA_DIR / "print_history.parquet")
    exchange_rates = pd.read_parquet(DATA_DIR / "exchange_rates.parquet")

    if print_current_prices.empty or print_history.empty or exchange_rates.empty:
        return pd.DataFrame(columns=["oracle_id", "scryfall_id", "date", "jpy_est"])

    latest_rate = exchange_rates.sort_values("date")["usd_to_jpy"].iloc[-1]
    premium_scryfall_ids = identify_premium_prints(print_current_prices, latest_rate)

    reserved_serialized_oracle_ids = set(
        static_attrs.loc[
            static_attrs["is_reserved"].fillna(False) | static_attrs["is_serialized"].fillna(False),
            "oracle_id",
        ]
    )
    reserved_serialized_scryfall_ids = set(
        print_current_prices.loc[
            print_current_prices["oracle_id"].isin(reserved_serialized_oracle_ids), "scryfall_id"
        ]
    )
    candidate_scryfall_ids = premium_scryfall_ids | reserved_serialized_scryfall_ids

    scryfall_to_oracle = print_current_prices.drop_duplicates("scryfall_id").set_index("scryfall_id")[
        "oracle_id"
    ]

    price_history = print_history[print_history["scryfall_id"].isin(candidate_scryfall_ids)].copy()
    price_history["oracle_id"] = price_history["scryfall_id"].map(scryfall_to_oracle)
    price_history = price_history.dropna(subset=["oracle_id"])
    price_history = price_history.merge(exchange_rates, on="date", how="left")
    price_history["jpy_est"] = (
        price_history["usd_foil"].fillna(price_history["usd"]) * price_history["usd_to_jpy"]
    )
    price_history = price_history.dropna(subset=["jpy_est", "usd_to_jpy"])

    static = build_static_features(static_attrs)
    ts = build_time_series_features(price_history, id_column="scryfall_id")

    # 1オラクルに複数のプレミアムプリントがあると、同じ(oracle_id, date)の組がtsに
    # 複数回出現する。reprint/banned/rotationはどれも(oracle_id, date)1組につき1行を
    # 前提にしているため、重複が無いオラクル単位のキーで先に計算してから多対1で
    # 結合する（重複したまま渡すと結合キー側の重複と掛け合わさり、組み合わせ爆発で
    # メモリを使い果たす。2026-08-22判明）。
    oracle_dates = ts[["oracle_id", "date"]].drop_duplicates()
    reprint = build_reprint_features(oracle_dates)
    banned = build_banned_feature(oracle_dates)
    rotation = build_standard_rotation_feature(oracle_dates)

    frame = ts.merge(static, on="oracle_id", how="left")
    frame = frame.merge(reprint, on=["oracle_id", "date"], how="left")
    frame = frame.merge(banned, on=["oracle_id", "date"], how="left")
    frame = frame.merge(rotation, on=["oracle_id", "date"], how="left")
    return frame


def build_training_frame(segment: str) -> pd.DataFrame:
    """価格が動く理由が正反対の2層を別モデルで扱うため、segmentごとに候補・価格系列
    ともに分けて組み立てる（_build_competitive_frame/_build_collector_frame参照）。"""
    if segment not in SEGMENTS:
        raise ValueError(f"segment must be one of {SEGMENTS}, got {segment!r}")

    static_attrs = pd.read_parquet(DATA_DIR / "static_attrs.parquet")

    if segment == "competitive":
        usage_stats = pd.read_parquet(DATA_DIR / "usage_stats.parquet")
        frame = _build_competitive_frame(static_attrs, usage_stats)
    else:
        frame = _build_collector_frame(static_attrs)

    # collectorはusage_rate等の採用率・アーキタイプ系特徴量を計算しないため、
    # FEATURE_COLUMNSの列名だけ揃える（値はNaNのまま、LightGBMのネイティブな欠損値
    # 対応に委ねる）。
    for column in FEATURE_COLUMNS:
        if column not in frame.columns:
            frame[column] = np.nan

    # バルク価格帯の行は%変動がノイズだらけになるため、その日の価格が閾値未満の行は除く
    # （移動平均・モメンタムはbuild_time_series_featuresの時点で全価格帯を見て計算済みなので、
    # ここで行を落としても計算自体は歪まない）。
    frame = frame[frame["jpy_est"] >= CANDIDATE_MIN_PRICE_JPY]

    # 採用率はNaNのまま残す（card_usage_statsが直近60日しか保持していないため、
    # 「データが無い」を0%（未採用）で埋めると「本当に未採用」と区別が付かなくなる。
    # Pawlicki et al.は採用率が無いサンプルをデータセットから除外していたが、この
    # プロジェクトでは大半の行が該当し除外は非現実的なため、LightGBMのネイティブな
    # 欠損値対応（train_baseline.pyのprint_top_movers参照）に委ねる）
    frame["is_reserved"] = frame["is_reserved"].fillna(0).astype(int)
    frame["is_serialized"] = frame["is_serialized"].fillna(0).astype(int)
    # reprint_count/days_since_last_reprintは再録履歴データが無いオラクル（bulk data
    # から漏れた特殊カード等）でのみNaNになりうるため0埋めする。is_bannedは禁止履歴に
    # 無ければ確実に未禁止なので0で正しい。days_since_last_reprintは「まだ再録が無い」
    # 場合もNaNだが、これは意味のある欠損（LightGBMのネイティブ対応に委ねる）なので
    # 埋めない。
    frame["reprint_count"] = frame["reprint_count"].fillna(0).astype(int)
    frame["is_banned"] = frame["is_banned"].fillna(0).astype(int)

    # 移動平均・ボラティリティが計算できない立ち上がり期間の行は学習から除外する
    frame = frame.dropna(subset=["ma_30d", "volatility_7d"])

    return frame


FEATURE_COLUMNS = [
    "log_price",
    "return_1d",
    "return_3d",
    "return_7d",
    "return_30d",
    "ma_7d",
    "ma_30d",
    "price_vs_ma7d",
    "volatility_7d",
    "usage_rate_max",
] + [f"usage_rate_change_{d}d" for d in USAGE_CHANGE_LAG_DAYS] + [
    "rarity_num",
    "cmc",
    "is_reserved",
    "is_serialized",
    "reprint_count",
    "days_since_last_reprint",
    "days_since_release",
    "is_banned",
    "days_since_ban",
    "set_avg_return_7d",
    "win_rate_avg_7d",
    "avg_copies_7d",
    "sideboard_usage_rate_max",
] + [f"sideboard_usage_rate_change_{d}d" for d in USAGE_CHANGE_LAG_DAYS] + [
    "days_until_rotation",
    "archetype_avg_return_7d",
] + [
    f"is_{c.lower()}" for c in TYPE_CATEGORIES
]

TARGET_COLUMN = "log_return_7d_max"


def target_column_for_direction(direction: str) -> str:
    """up（急騰）はlog_return_7d_max（7日以内のどこかで最大どれだけ上がったか）、
    down（急落）はlog_return_7d_min（同、最大どれだけ下がったか）を使う。TARGET_COLUMN
    （up側のデフォルト）を閾値判定にそのまま流用すると、急落側は「7日間の最大上昇率が
    下限を下回るか」という意味の通らない判定になってしまうため分離した（2026-08-27）。
    どちらも同じ7日完全窓（complete_window）でNaN化されるため、行の絞り込み
    （dropna(subset=[TARGET_COLUMN])）自体はup側のTARGET_COLUMNのままで問題ない。"""
    return "log_return_7d_max" if direction == "up" else "log_return_7d_min"


if __name__ == "__main__":
    for segment in SEGMENTS:
        frame = build_training_frame(segment)
        print(f"[{segment}] 特徴量データフレーム: {len(frame)}行 x {len(frame.columns)}列")
        print(f"[{segment}] 目的変数(log_return_7d)が計算できる行: {frame[TARGET_COLUMN].notna().sum()}行")
        frame.to_parquet(DATA_DIR / f"training_frame_{segment}.parquet", index=False)
