"""
ml/data/配下のParquetキャッシュ（fetch_data.pyが生成）がいつ取得されたものかを表示し、
古すぎる場合は警告する。2026-08-24、古いローカルキャッシュを見て「Mox Sapphire/Rubyが
暴落した」という誤った分析結果を報告してしまった事故を受けて追加した。分析を始める前に
必ずこれを実行し、必要ならfetch_data.pyを再実行してから進めること。

実行: python ml/check_cache_freshness.py
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
WARN_AFTER_HOURS = 6

FILES = [
    "price_history.parquet",
    "print_history.parquet",
    "print_current_prices.parquet",
    "usage_stats.parquet",
    "static_attrs.parquet",
    "exchange_rates.parquet",
]


def main() -> None:
    now = time.time()
    for name in FILES:
        path = DATA_DIR / name
        if not path.exists():
            print(f"  {name}: 存在しません")
            continue
        age_hours = (now - path.stat().st_mtime) / 3600
        mtime = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        warn = " [WARN] 古い可能性あり（fetch_data.pyの再実行を検討）" if age_hours > WARN_AFTER_HOURS else ""
        print(f"  {name}: 取得日時 {mtime}（{age_hours:.1f}時間前）{warn}")


if __name__ == "__main__":
    main()
