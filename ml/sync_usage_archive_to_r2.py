"""
ローカルのml/data/usage_stats.parquet（ml/fetch_tournament_history.mjs +
ml/build_usage_history_from_tournaments.pyが作る、TopDeck.gg由来の採用率）を
R2（usage-history/YYYY-MM.ndjson.gz、月次バルク）へマージ書き込みする。

日次パイプラインでは直近days_backのごく短い窓だけをTopDeckから再取得・再計算して
ここに渡す（過去分はGETで取得済みの月次ファイルと(oracle_id, format, date)キーで
マージするので、重複日は上書き、他の日は保持される）。初回はローカルの15ヶ月分
フルデータをそのまま渡してR2側の初期投入（シード）に使う。

scripts/lib/r2PriceArchive.mjsのmergeMonthFileと同じ設計をPythonで再実装している
（ml/はPython、価格アーカイブ側はNode.jsで完結しているため言語を揃えず別実装にした）。

実行: R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
      python ml/sync_usage_archive_to_r2.py
"""

from __future__ import annotations

import gzip
import io
import json
import os
from pathlib import Path

import pandas as pd

from fetch_data import r2_client

DATA_DIR = Path(__file__).parent / "data"
USAGE_STATS_PATH = DATA_DIR / "usage_stats.parquet"
R2_PREFIX = "usage-history"


def read_month(s3, bucket: str, month: str) -> list[dict]:
    key = f"{R2_PREFIX}/{month}.ndjson.gz"
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except s3.exceptions.NoSuchKey:
        return []
    with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
        return [json.loads(line) for line in gz if line.strip()]


def write_month(s3, bucket: str, month: str, rows: list[dict]) -> None:
    key = f"{R2_PREFIX}/{month}.ndjson.gz"
    body = "\n".join(json.dumps(r) for r in rows) + "\n"
    gz = gzip.compress(body.encode("utf-8"))
    s3.put_object(Bucket=bucket, Key=key, Body=gz)


def main() -> None:
    if not USAGE_STATS_PATH.exists():
        raise SystemExit(
            f"{USAGE_STATS_PATH} がありません。先にml/fetch_tournament_history.mjs → "
            "ml/build_usage_history_from_tournaments.py を実行してください。"
        )

    df = pd.read_parquet(USAGE_STATS_PATH)
    df["calculated_at"] = pd.to_datetime(df["calculated_at"]).dt.strftime("%Y-%m-%d")
    df["month"] = df["calculated_at"].str.slice(0, 7)

    s3 = r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]

    for month, month_df in df.groupby("month"):
        existing = read_month(s3, bucket, month)
        by_key = {(r["oracle_id"], r["format"], r["calculated_at"]): r for r in existing}
        for _, row in month_df.iterrows():
            key = (row["oracle_id"], row["format"], row["calculated_at"])
            by_key[key] = {
                "oracle_id": row["oracle_id"],
                "format": row["format"],
                "usage_rate": float(row["usage_rate"]),
                "deck_sample_size": float(row["deck_sample_size"]),
                "calculated_at": row["calculated_at"],
            }
        merged = sorted(by_key.values(), key=lambda r: (r["oracle_id"], r["format"], r["calculated_at"]))
        write_month(s3, bucket, month, merged)
        print(f"  {month}: {len(month_df)}行マージ → 計{len(merged)}行")

    print(f"完了。{df['month'].nunique()}ヶ月分をR2（{R2_PREFIX}/）へ反映しました。")


if __name__ == "__main__":
    main()
