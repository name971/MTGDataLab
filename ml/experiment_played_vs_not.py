"""
1週目→2週目の価格変化が、「実際にデッキで使われたか」で違いが出るか確認する。
既存のexperiment_week1_week2_results.csvに、対応するoracle_idのデッキ採用実績
（deck_cardsに1件でも登場するか）を突き合わせる。
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
    res_df = pd.read_csv("experiment_week1_week2_results.csv")
    scryfall_ids = res_df["scryfall_id"].tolist()

    print("scryfall_id -> oracle_idの対応を取得中...")
    oracle_map_rows = []
    CHUNK = 150
    for i in range(0, len(scryfall_ids), CHUNK):
        chunk = scryfall_ids[i:i + CHUNK]
        ids_str = ",".join(chunk)
        oracle_map_rows.extend(
            supabase_get_all(f"card_prints?select=scryfall_id,oracle_id&scryfall_id=in.({ids_str})")
        )
    oracle_map = {r["scryfall_id"]: r["oracle_id"] for r in oracle_map_rows}
    res_df["oracle_id"] = res_df["scryfall_id"].map(oracle_map)
    res_df = res_df.dropna(subset=["oracle_id"])

    print("採用率統計（card_usage_stats）からプレイ実績のあるoracle_id一覧を取得中...")
    # period_days=30の行が1件でもあれば「そのフォーマットで直近使われたことがある」とみなす
    usage_rows = supabase_get_all("card_usage_stats?select=oracle_id&period_days=eq.30")
    played_oracle_ids = {r["oracle_id"] for r in usage_rows}
    print(f"直近デッキ採用実績のあるオラクル: {len(played_oracle_ids)}件")

    res_df["played"] = res_df["oracle_id"].isin(played_oracle_ids)

    for rarity in ["rare", "mythic"]:
        sub = res_df[res_df["rarity"] == rarity]
        print(f"\n=== {rarity} ===")
        for played, label in [(True, "採用実績あり"), (False, "採用実績なし")]:
            g = sub[sub["played"] == played]
            if len(g) == 0:
                continue
            print(f"  {label}（n={len(g)}）: 変化率平均 {g['pct_change'].mean():+.1f}%、"
                  f"中央値 {g['pct_change'].median():+.1f}%、"
                  f"上昇割合 {(g['pct_change'] > 0).mean()*100:.0f}%")

    res_df.to_csv("experiment_played_vs_not_results.csv", index=False)
    print("\n詳細結果: ml/experiment_played_vs_not_results.csv")


if __name__ == "__main__":
    main()
