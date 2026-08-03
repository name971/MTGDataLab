"""
価格予測モデルの学習データを組み立てる。

データソース:
  1. Supabase（自前の実データ、REST経由）
     - card_cheapest_price_snapshots: オラクル単位・日付単位の最安値（USD/JPY）
       2026-07-24以降のみ（本番サイトの実運用データ、最も信頼できる）
     - card_usage_stats: フォーマット別・日付別の採用率
     - card_oracles / cards: 静的属性（レアリティ・タイプ・マナコスト）
     - exchange_rates: USD→JPY換算用
  2. MTGJSON（AllIdentifiers / AllPrices）
     - 直近90日分のTCGplayer価格。Supabase実データより古い日付だけを補完に使う
       （実データと重複する日付はSupabase側を優先）。

本番のPostgres DB（無料枠500MB）には一切書き込まない。取得結果はml/data/配下に
Parquetでキャッシュするのみ（再実行時の高速化・オフライン作業用）。

実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... python ml/fetch_data.py
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path

import pandas as pd
import requests

DATA_DIR = Path(__file__).parent / "data"
CACHE_DIR = DATA_DIR / "cache"

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")

MTGJSON_IDENTIFIERS_URL = "https://mtgjson.com/api/v5/AllIdentifiers.json.zip"
MTGJSON_PRICES_URL = "https://mtgjson.com/api/v5/AllPrices.json.zip"

PAGE_SIZE = 1000


def _require_supabase_env() -> None:
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise SystemExit(
            "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください"
        )


def supabase_get_all(path: str) -> list[dict]:
    """PostgRESTのRange指定で全件ページングして取得する（REST APIの1000行上限対策）。"""
    _require_supabase_env()
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


def fetch_supabase_price_history() -> pd.DataFrame:
    """card_cheapest_price_snapshots: 自前の実価格履歴（最も信頼できるソース）。"""
    print("Supabase: card_cheapest_price_snapshots を取得中...")
    rows = supabase_get_all(
        "card_cheapest_price_snapshots?select=oracle_id,date,jpy_est&jpy_est=not.is.null"
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df["jpy_est"] = df["jpy_est"].astype(float)
    print(f"  {len(df)}行（{df['date'].min().date()}〜{df['date'].max().date()}）")
    return df


def fetch_supabase_usage_stats() -> pd.DataFrame:
    """card_usage_stats: 採用率（meta_shareの代理変数）。period_days=7のものだけ使う
    （compute-card-streaks.mjsと同じ考え方で、母数の入れ替わりが最も速いため）。"""
    print("Supabase: card_usage_stats を取得中...")
    rows = supabase_get_all(
        "card_usage_stats?select=oracle_id,format,usage_rate,calculated_at&period_days=eq.7"
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["calculated_at"] = pd.to_datetime(df["calculated_at"])
    df["usage_rate"] = df["usage_rate"].astype(float)
    print(f"  {len(df)}行")
    return df


def fetch_supabase_static_attrs() -> pd.DataFrame:
    """card_oracles + cards: レアリティ・タイプ・マナコスト等の静的属性（代表プリント基準）。"""
    print("Supabase: 静的属性（cards）を取得中...")
    rows = supabase_get_all(
        "cards?select=oracle_id,rarity,type_line,mana_cost,lang&lang=eq.en"
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    # 同一oracle_idで複数プリントがある場合は最初の1件のみ採用（英語版のみ絞り込み済み）
    df = df.drop_duplicates(subset="oracle_id", keep="first")
    print(f"  {len(df)}件のオラクル")
    return df


def fetch_supabase_exchange_rates() -> pd.DataFrame:
    print("Supabase: exchange_rates を取得中...")
    rows = supabase_get_all("exchange_rates?select=date,usd_to_jpy")
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df["usd_to_jpy"] = df["usd_to_jpy"].astype(float)
    return df.sort_values("date")


def _download_and_cache_zip(url: str, cache_name: str) -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / cache_name
    if cache_path.exists():
        print(f"  キャッシュ利用: {cache_path}")
        return json.loads(cache_path.read_text(encoding="utf-8"))

    print(f"  ダウンロード中: {url}")
    res = requests.get(url, timeout=300)
    res.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        inner_name = zf.namelist()[0]
        with zf.open(inner_name) as f:
            data = json.load(f)
    cache_path.write_text(json.dumps(data), encoding="utf-8")
    return data


def fetch_mtgjson_scryfall_id_map() -> dict[str, str]:
    """MTGJSON独自uuid -> ScryfallのscryfallIdの対応表を作る
    （AllPricesのキーはMTGJSON独自uuidで、我々のDBはscryfall_id基準のため変換が必要）。"""
    print("MTGJSON: AllIdentifiers を取得中...")
    data = _download_and_cache_zip(MTGJSON_IDENTIFIERS_URL, "AllIdentifiers.json")
    uuid_to_scryfall: dict[str, str] = {}
    for uuid, card in data.get("data", {}).items():
        scryfall_id = (card.get("identifiers") or {}).get("scryfallId")
        if scryfall_id:
            uuid_to_scryfall[uuid] = scryfall_id
    print(f"  {len(uuid_to_scryfall)}件のuuid→scryfallId対応")
    return uuid_to_scryfall


def fetch_mtgjson_price_history(uuid_to_scryfall: dict[str, str]) -> pd.DataFrame:
    """MTGJSON AllPrices（直近90日ローリング）から、paper/tcgplayer/retail/normalのUSD価格を
    プリント単位（scryfall_id）の日次系列として取り出す。Foilは今回のv1では見送り
    （通常価格だけでもまず十分な学習データ量を確保する）。"""
    print("MTGJSON: AllPrices を取得中...")
    data = _download_and_cache_zip(MTGJSON_PRICES_URL, "AllPrices.json")
    records = []
    for uuid, price_obj in data.get("data", {}).items():
        scryfall_id = uuid_to_scryfall.get(uuid)
        if not scryfall_id:
            continue
        normal = (
            (price_obj.get("paper") or {})
            .get("tcgplayer", {})
            .get("retail", {})
            .get("normal")
        )
        if not normal:
            continue
        for date_str, usd in normal.items():
            if usd is None:
                continue
            records.append({"scryfall_id": scryfall_id, "date": date_str, "usd": float(usd)})
    df = pd.DataFrame(records)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    print(f"  {len(df)}行（{df['scryfall_id'].nunique()}プリント分）")
    return df


def fetch_supabase_print_to_oracle() -> pd.DataFrame:
    """card_prints: scryfall_id -> oracle_id の対応（MTGJSON価格をオラクル単位に集約するため）。
    トーナメント使用不可プリント（金縁・銀縁等）はcompute-cheapest-price-snapshots.mjsと同じ
    方針で除外する。"""
    print("Supabase: card_prints（scryfall_id→oracle_id対応）を取得中...")
    rows = supabase_get_all(
        "card_prints?select=scryfall_id,oracle_id&not_tournament_legal=eq.false"
    )
    return pd.DataFrame(rows)


def build_mtgjson_oracle_price_history(
    mtgjson_prices: pd.DataFrame, print_to_oracle: pd.DataFrame, exchange_rates: pd.DataFrame
) -> pd.DataFrame:
    """MTGJSONのプリント単位USD価格を、compute-cheapest-price-snapshots.mjsと同じロジック
    （オラクル×日付ごとの最安値）でオラクル単位に集約し、JPYに換算する。"""
    if mtgjson_prices.empty or print_to_oracle.empty:
        return pd.DataFrame(columns=["oracle_id", "date", "jpy_est"])

    merged = mtgjson_prices.merge(print_to_oracle, on="scryfall_id", how="inner")
    cheapest = merged.groupby(["oracle_id", "date"], as_index=False)["usd"].min()

    rates = exchange_rates.set_index("date")["usd_to_jpy"].sort_index()
    # その日以前で一番近い日のレートを使う（src/lib/dbCardPrintPrices.tsと同じフォールバック）
    cheapest = cheapest.sort_values("date")
    cheapest["rate"] = cheapest["date"].map(lambda d: rates.asof(d))
    cheapest = cheapest.dropna(subset=["rate"])
    cheapest["jpy_est"] = (cheapest["usd"] * cheapest["rate"]).round(2)
    return cheapest[["oracle_id", "date", "jpy_est"]]


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    own_history = fetch_supabase_price_history()
    exchange_rates = fetch_supabase_exchange_rates()
    print_to_oracle = fetch_supabase_print_to_oracle()

    uuid_to_scryfall = fetch_mtgjson_scryfall_id_map()
    mtgjson_prices = fetch_mtgjson_price_history(uuid_to_scryfall)
    mtgjson_oracle_history = build_mtgjson_oracle_price_history(
        mtgjson_prices, print_to_oracle, exchange_rates
    )

    # 実データ（own_history）にある日付はMTGJSON側より優先し、無い日付だけMTGJSONで補完する
    # （収集タイミングの違いによる二重計上・誤差混入を避けるため）。
    if not own_history.empty:
        own_keys = set(zip(own_history["oracle_id"], own_history["date"]))
        mtgjson_oracle_history = mtgjson_oracle_history[
            ~mtgjson_oracle_history.apply(
                lambda r: (r["oracle_id"], r["date"]) in own_keys, axis=1
            )
        ]

    combined = pd.concat(
        [own_history[["oracle_id", "date", "jpy_est"]], mtgjson_oracle_history],
        ignore_index=True,
    ).drop_duplicates(subset=["oracle_id", "date"])
    combined = combined.sort_values(["oracle_id", "date"])

    print(
        f"\n価格履歴マージ完了: {len(combined)}行、"
        f"{combined['date'].min().date()}〜{combined['date'].max().date()}、"
        f"{combined['oracle_id'].nunique()}オラクル"
    )

    combined.to_parquet(DATA_DIR / "price_history.parquet", index=False)
    fetch_supabase_usage_stats().to_parquet(DATA_DIR / "usage_stats.parquet", index=False)
    fetch_supabase_static_attrs().to_parquet(DATA_DIR / "static_attrs.parquet", index=False)
    print(f"\n{DATA_DIR} にキャッシュ保存しました。")


if __name__ == "__main__":
    main()
