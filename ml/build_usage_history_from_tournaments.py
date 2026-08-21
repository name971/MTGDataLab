"""
ml/fetch_tournament_history.mjs が書き出したml/data/tournament_usage_history.ndjson
（1行=1デッキ×1オラクル、または oracle_id=null でデッキの存在のみを表す行。各行に
そのデッキのwin_rateも付いている）から、2つのローカルParquetを作る:

1. usage_stats.parquet: scripts/compute-deck-stats.mjs と同じ定義（フォーマット別、
   直近7日ローリング窓、メインボードのユニークオラクル数 / その窓の総デッキ数）。
   ml/fetch_data.py のfetch_supabase_usage_stats()と同じ列（oracle_id, format,
   usage_rate, deck_sample_size, calculated_at）で出力するので、features.pyは
   変更不要でそのまま読める。board=="main"のみを対象にする。
2. win_rate_history.parquet: そのカードを採用しているデッキの平均勝率（win_rate_avg_7d）
   と平均投入枚数（avg_copies_7d、フォーマット横断、直近7日ローリング窓、board=="main"
   のみ）。win_rateはアーキタイプ分類（MTGOFormatDataのルール未整備のため未実装）を
   経由せず、「勝っているデッキで使われているカードは今後採用率が上がりやすい」という
   先行指標をカード単位で直接作る。avg_copies_7dは「1枚でも入っているか」の有無だけ
   だった採用率に対し、4枚フル投入のコア戦略カードと1枚だけのタッチ採用を区別する。
3. sideboard_usage_stats.parquet: サイドボードでの採用率（usage_stats.parquetと同じ
   定義、board=="side"のみ）。サイドボードは対策カードだけでなく汎用的な回答カードも
   多く、メインボードから除外すると需要シグナルが完全に見えなくなるため
   （2026-08-16、ユーザー指摘）、メイン採用率とは別の特徴量として追加する。

どこにも書き込みは行わない（完全ローカル）。

日ごとに全行をフィルタする素朴な実装は、Commanderだけで900万行超あるため実用的な
時間で終わらない。日別カウントをピボットしてrolling(7).sum()で一括計算する
（build_usage_features/build_reprint_featuresと同じベクトル化の考え方）。

実行: python ml/build_usage_history_from_tournaments.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).parent / "data"
INPUT_PATH = DATA_DIR / "tournament_usage_history.ndjson"
OUTPUT_PATH = DATA_DIR / "usage_stats.parquet"
SIDEBOARD_OUTPUT_PATH = DATA_DIR / "sideboard_usage_stats.parquet"
WIN_RATE_OUTPUT_PATH = DATA_DIR / "win_rate_history.parquet"

PERIOD_DAYS = 7  # ml/fetch_data.pyがperiod_days=7だけを使うのに合わせる


def load_raw_rows() -> pd.DataFrame:
    df = pd.read_json(INPUT_PATH, lines=True)
    df["event_date"] = pd.to_datetime(df["event_date"])
    return df


def compute_rolling_usage_rate(df: pd.DataFrame, board: str = "main") -> pd.DataFrame:
    """board=="main"（デフォルト、既存のusage_stats.parquet用）またはboard=="side"
    （sideboard_usage_stats.parquet用）で採用率を計算する。総デッキ数の分母は
    boardを問わずデッキ単位でユニークカウントする（boardフィルタ前のdfをそのまま
    渡す設計にすると分母がズレるため、呼び出し側でdfを絞り込まず、ここで
    board列を見て分子だけ絞り込む）。"""
    all_dates = pd.date_range(df["event_date"].min(), df["event_date"].max(), freq="D")
    output_frames = []

    for format_name, format_df in df.groupby("format", sort=False):
        # 総デッキ数（分母）: 日別のユニークdeck_id数をrolling(7).sumで7日窓の合計にする
        deck_dates = format_df.drop_duplicates(subset=["deck_id"])[["deck_id", "event_date"]]
        daily_deck_count = deck_dates.groupby("event_date").size().reindex(all_dates, fill_value=0)
        total_decks_by_date = daily_deck_count.rolling(PERIOD_DAYS, min_periods=1).sum()

        # 分子: オラクル×日付でユニークdeck_id数を数えてから、日付×オラクルのピボットに
        # してrolling(7).sumで7日窓の合計にする（オラクル種類数が多いため疎行列的に扱う）
        oracle_rows = format_df[(format_df["oracle_id"].notna()) & (format_df["board"] == board)]
        daily_oracle_deck_count = (
            oracle_rows.drop_duplicates(subset=["deck_id", "oracle_id"])
            .groupby(["event_date", "oracle_id"])
            .size()
        )
        pivot = daily_oracle_deck_count.unstack(fill_value=0).reindex(all_dates, fill_value=0)
        rolling_oracle_counts = pivot.rolling(PERIOD_DAYS, min_periods=1).sum()

        # 総デッキ数が0の日（そのフォーマットの大会が無い日）は採用率が定義できないため除く
        valid_dates = total_decks_by_date[total_decks_by_date > 0].index
        rolling_oracle_counts = rolling_oracle_counts.loc[valid_dates]
        total_decks_valid = total_decks_by_date.loc[valid_dates]

        usage_rate = rolling_oracle_counts.div(total_decks_valid, axis=0) * 100
        long = usage_rate.stack().rename("usage_rate").reset_index()
        long.columns = ["calculated_at", "oracle_id", "usage_rate"]
        long = long[long["usage_rate"] > 0]
        long["usage_rate"] = long["usage_rate"].round(2)
        long["format"] = format_name
        long["deck_sample_size"] = long["calculated_at"].map(total_decks_valid.astype(int))

        output_frames.append(long[["oracle_id", "format", "usage_rate", "deck_sample_size", "calculated_at"]])

    return pd.concat(output_frames, ignore_index=True) if output_frames else pd.DataFrame(
        columns=["oracle_id", "format", "usage_rate", "deck_sample_size", "calculated_at"]
    )


def compute_rolling_win_rate(df: pd.DataFrame) -> pd.DataFrame:
    """フォーマット横断（usage_rate_maxと同様、プールする）で、そのオラクルを採用した
    デッキの平均勝率を直近7日ローリング窓で計算する。win_rateがnullの大会（勝敗記録が
    無い）は分母・分子どちらからも除く。"""
    all_dates = pd.date_range(df["event_date"].min(), df["event_date"].max(), freq="D")

    valid = df[df["oracle_id"].notna() & df["win_rate"].notna() & (df["board"] == "main")]
    # 同じデッキ内で同じオラクルが複数回登場することは無いはずだが、念のため重複除去
    dedup = valid.drop_duplicates(subset=["deck_id", "oracle_id"])[["event_date", "oracle_id", "win_rate"]]

    sum_pivot = (
        dedup.groupby(["event_date", "oracle_id"])["win_rate"].sum().unstack(fill_value=0).reindex(all_dates, fill_value=0)
    )
    count_pivot = (
        dedup.groupby(["event_date", "oracle_id"]).size().unstack(fill_value=0).reindex(all_dates, fill_value=0)
    )
    rolling_sum = sum_pivot.rolling(PERIOD_DAYS, min_periods=1).sum()
    rolling_count = count_pivot.rolling(PERIOD_DAYS, min_periods=1).sum()

    avg = rolling_sum.div(rolling_count.replace(0, np.nan))
    long = avg.stack().rename("win_rate_avg_7d").reset_index()
    long.columns = ["calculated_at", "oracle_id", "win_rate_avg_7d"]
    long["win_rate_avg_7d"] = long["win_rate_avg_7d"].round(4)
    return long


def compute_rolling_avg_copies(df: pd.DataFrame) -> pd.DataFrame:
    """フォーマット横断で、そのオラクルがデッキに投入されていた平均枚数を直近7日
    ローリング窓で計算する（quantityがnullの行＝デッキ存在行は除く）。"""
    all_dates = pd.date_range(df["event_date"].min(), df["event_date"].max(), freq="D")

    valid = df[df["oracle_id"].notna() & df["quantity"].notna() & (df["board"] == "main")]
    dedup = valid.drop_duplicates(subset=["deck_id", "oracle_id"])[["event_date", "oracle_id", "quantity"]]

    sum_pivot = (
        dedup.groupby(["event_date", "oracle_id"])["quantity"].sum().unstack(fill_value=0).reindex(all_dates, fill_value=0)
    )
    count_pivot = (
        dedup.groupby(["event_date", "oracle_id"]).size().unstack(fill_value=0).reindex(all_dates, fill_value=0)
    )
    rolling_sum = sum_pivot.rolling(PERIOD_DAYS, min_periods=1).sum()
    rolling_count = count_pivot.rolling(PERIOD_DAYS, min_periods=1).sum()

    avg = rolling_sum.div(rolling_count.replace(0, np.nan))
    long = avg.stack().rename("avg_copies_7d").reset_index()
    long.columns = ["calculated_at", "oracle_id", "avg_copies_7d"]
    long["avg_copies_7d"] = long["avg_copies_7d"].round(2)
    return long


def main() -> None:
    if not INPUT_PATH.exists():
        raise SystemExit(f"{INPUT_PATH} がありません。先に node ml/fetch_tournament_history.mjs を実行してください。")

    print("トーナメント履歴を読み込み中...")
    raw = load_raw_rows()
    print(f"  {len(raw)}行、{raw['event_date'].min().date()}〜{raw['event_date'].max().date()}")

    print("フォーマット別・日別の採用率を計算中（ローリング7日窓）...")
    usage_stats = compute_rolling_usage_rate(raw)
    print(f"  {len(usage_stats)}行")

    usage_stats.to_parquet(OUTPUT_PATH, index=False)
    print(f"書き出し完了: {OUTPUT_PATH}")

    print("フォーマット別・日別のサイドボード採用率を計算中（ローリング7日窓）...")
    sideboard_usage_stats = compute_rolling_usage_rate(raw, board="side")
    print(f"  {len(sideboard_usage_stats)}行")
    sideboard_usage_stats.to_parquet(SIDEBOARD_OUTPUT_PATH, index=False)
    print(f"書き出し完了: {SIDEBOARD_OUTPUT_PATH}")

    print("カード採用デッキの平均勝率を計算中（ローリング7日窓）...")
    win_rate_history = compute_rolling_win_rate(raw)
    print(f"  {len(win_rate_history)}行")

    print("カードの平均投入枚数を計算中（ローリング7日窓）...")
    avg_copies_history = compute_rolling_avg_copies(raw)
    print(f"  {len(avg_copies_history)}行")

    combined = win_rate_history.merge(avg_copies_history, on=["oracle_id", "calculated_at"], how="outer")
    combined.to_parquet(WIN_RATE_OUTPUT_PATH, index=False)
    print(f"書き出し完了: {WIN_RATE_OUTPUT_PATH}")


if __name__ == "__main__":
    main()
