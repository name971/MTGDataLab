"""
発売から1週目の平均価格 vs 2週目の平均価格を、レア/神話レア別に集計する。
価格はprint_history.parquet（scryfall_id単位、USD）を使う。
"""

from __future__ import annotations

import os

import pandas as pd
import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
PAGE_SIZE = 1000


def supabase_get_all(path: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        res = requests.get(
            f"{SUPABASE_URL}/rest/v1/{path}",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                "Range": f"{offset}-{offset + PAGE_SIZE - 1}",
            },
            timeout=60,
        )
        res.raise_for_status()
        page = res.json()
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def main() -> None:
    print("card_printsからレア/神話レアのプリント一覧を取得中...")
    rows = supabase_get_all(
        "card_prints?select=scryfall_id,rarity,released_at"
        "&rarity=in.(rare,mythic)&released_at=gte.2024-02-15&released_at=lte.2026-07-15"
        "&order=released_at.asc"
    )
    prints_df = pd.DataFrame(rows)
    prints_df["released_at"] = pd.to_datetime(prints_df["released_at"])
    print(f"対象プリント: {len(prints_df)}件")

    print("print_history.parquetを読み込み中...")
    price_df = pd.read_parquet("data/print_history.parquet")
    price_df["date"] = pd.to_datetime(price_df["date"])

    # scryfall_idごとに日付->usdのMapを作る（Foilは除外、通常版のみ）
    price_by_scryfall: dict[str, pd.Series] = {
        sid: g.set_index("date")["usd"] for sid, g in price_df.groupby("scryfall_id")
    }

    results = []
    for row in prints_df.itertuples():
        series = price_by_scryfall.get(row.scryfall_id)
        if series is None:
            continue
        released = row.released_at
        week1_days = pd.date_range(released, released + pd.Timedelta(days=6))
        week2_days = pd.date_range(released + pd.Timedelta(days=7), released + pd.Timedelta(days=13))
        week1_vals = series.reindex(week1_days).dropna()
        week2_vals = series.reindex(week2_days).dropna()
        # 両週とも最低4日分のデータが無いものは信頼できないので除外
        if len(week1_vals) < 4 or len(week2_vals) < 4:
            continue
        week1_avg = week1_vals.mean()
        week2_avg = week2_vals.mean()
        if week1_avg <= 0:
            continue
        pct_change = (week2_avg - week1_avg) / week1_avg * 100
        results.append({
            "scryfall_id": row.scryfall_id,
            "rarity": row.rarity,
            "released_at": released,
            "week1_avg_usd": week1_avg,
            "week2_avg_usd": week2_avg,
            "pct_change": pct_change,
        })

    res_df = pd.DataFrame(results)
    print(f"\n1週目・2週目とも十分なデータがあるプリント: {len(res_df)}件")

    for rarity in ["rare", "mythic"]:
        sub = res_df[res_df["rarity"] == rarity]
        if len(sub) == 0:
            continue
        print(f"\n=== {rarity}（n={len(sub)}） ===")
        print(f"1週目平均価格の中央値: ${sub['week1_avg_usd'].median():.2f}")
        print(f"2週目平均価格の中央値: ${sub['week2_avg_usd'].median():.2f}")
        print(f"変化率の平均: {sub['pct_change'].mean():+.1f}%")
        print(f"変化率の中央値: {sub['pct_change'].median():+.1f}%")
        print(f"上昇した枚数: {(sub['pct_change'] > 0).sum()} / {len(sub)}")
        print(f"下落した枚数: {(sub['pct_change'] < 0).sum()} / {len(sub)}")

    res_df.to_csv("experiment_week1_week2_results.csv", index=False)
    print("\n詳細結果: ml/experiment_week1_week2_results.csv")


if __name__ == "__main__":
    main()
