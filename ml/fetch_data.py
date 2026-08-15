"""
価格予測モデルの学習データを組み立てる。

データソース:
  1. Cloudflare R2（自前の長期履歴、scripts/lib/r2PriceArchive.mjs参照）
     - price-history/*.ndjson.gz: 全カード・オラクル単位価格履歴（2024-02〜今日まで
       連続、TCGCSVバックフィル＋日次実データ、使用不可プリント除外済み）。
       以前はCloudflare D1（price_history_archive）に日次実データを書いていたが、
       2026-08-15にR2へ全面移行し、D1側は書き込みが完全に止まっている
       （docs/spec.md 4章・docs/incident-log.md参照）。今はR2単独で完結する。
  2. Supabase（自前の実データ、REST経由）
     - card_usage_stats: フォーマット別・日付別の採用率
     - card_oracles / cards: 静的属性（レアリティ・タイプ・マナコスト）
  3. Cloudflare D1（catalog_oracles、デッキ未使用カードのカタログ、HTTP API経由）
     - デッキで一度も使われていないためPostgresには無いオラクルの静的属性
       （こちらは今も現役、価格アーカイブとは別物）

本番のPostgres DB（無料枠500MB）には一切書き込まない。取得結果はml/data/配下に
Parquetでキャッシュするのみ（再実行時の高速化・オフライン作業用）。

実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=...
      CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
      python ml/fetch_data.py
"""

from __future__ import annotations

import gzip
import io
import json
import os
import zipfile
from pathlib import Path

import boto3
import pandas as pd
import requests

DATA_DIR = Path(__file__).parent / "data"
CACHE_DIR = DATA_DIR / "cache"

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")

CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
# wrangler.jsonc の d1_databases[].database_id と同じ（jp-mtgstocks-archive）
D1_DATABASE_ID = "a3f8dcb4-80d1-4dba-81dd-9ecd900e7623"

# ml/fetch_tcgcsv_history.pyがtcgplayerProductId→scryfallId対応の解決に使う
# （キャッシュが無い環境向けの自動ダウンロードフォールバック）
MTGJSON_IDENTIFIERS_URL = "https://mtgjson.com/api/v5/AllIdentifiers.json.zip"

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


def _require_d1_env() -> None:
    if not CLOUDFLARE_API_TOKEN or not CLOUDFLARE_ACCOUNT_ID:
        raise SystemExit("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を設定してください")


def d1_query(sql: str, params: list) -> list[dict]:
    _require_d1_env()
    res = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}"
        f"/d1/database/{D1_DATABASE_ID}/query",
        headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"},
        json={"sql": sql, "params": params},
        timeout=60,
    )
    res.raise_for_status()
    body = res.json()
    if not body.get("success"):
        raise RuntimeError(f"D1 query failed: {body}")
    return body["result"][0]["results"]


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
    """card_oracles: 再録禁止・シリアル番号フラグ（デッキ使用実績を問わず全オラクル対象）。
    cards: レアリティ・タイプ・マナコスト等（デッキ使用実績のある代表英語版のみ、
    デッキ未使用カードの分はfetch_d1_catalog_static_attrs()側で別途補う）。"""
    print("Supabase: 静的属性（card_oracles + cards）を取得中...")
    oracle_rows = supabase_get_all("card_oracles?select=oracle_id,is_reserved,is_serialized")
    oracle_df = pd.DataFrame(oracle_rows)

    card_rows = supabase_get_all("cards?select=oracle_id,rarity,type_line,mana_cost,lang&lang=eq.en")
    card_df = pd.DataFrame(card_rows)
    if not card_df.empty:
        # 同一oracle_idで複数プリントがある場合は最初の1件のみ採用（英語版のみ絞り込み済み）
        card_df = card_df.drop_duplicates(subset="oracle_id", keep="first")

    df = oracle_df.merge(card_df, on="oracle_id", how="left") if not oracle_df.empty else card_df
    print(f"  {len(df)}件のオラクル")
    return df


def fetch_d1_catalog_static_attrs() -> pd.DataFrame:
    """catalog_oracles（Cloudflare D1）: デッキ未使用のためPostgres cardsには無いオラクルの
    静的属性・再録禁止/シリアルフラグ。再録禁止リスト該当カードの大半はこちら側にいる
    （古いカードでデッキにはほぼ使われないため、DB容量対策の移行で先にD1へ移されている）。"""
    print("D1: catalog_oracles（デッキ未使用カード）を取得中...")
    rows = d1_query(
        "SELECT oracle_id, rarity, type_line, mana_cost, is_reserved, is_serialized FROM catalog_oracles",
        [],
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["is_reserved"] = df["is_reserved"].astype(bool)
    df["is_serialized"] = df["is_serialized"].astype(bool)
    print(f"  {len(df)}件")
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


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def fetch_r2_price_history() -> pd.DataFrame:
    """R2（price-history/*.ndjson.gz、scripts/lib/r2PriceArchive.mjs参照）: 全カードの
    オラクル単位価格履歴（2024-02〜今日まで連続、既にJPY換算済み）。今はこれが唯一の
    ソースで、D1との突き合わせ・優先順位付けは不要（ファイル内はscripts/lib/
    r2PriceArchive.mjsのmergeCardFileが日付キー単位で既に重複排除済み）。
    Parquetでなくgzip圧縮NDJSONにしている理由はscripts/lib/r2PriceArchive.mjsの
    モジュールdocstring参照（Cloudflare Workers側のCPU時間制限の都合）。"""
    print("R2: price-history（長期履歴）を取得中...")
    s3 = r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    records = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="price-history/"):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith(".ndjson.gz"):
                continue
            body = s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read()
            with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
                records.extend(json.loads(line) for line in gz if line.strip())
    if not records:
        return pd.DataFrame(columns=["oracle_id", "date", "jpy_est"])
    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"])
    df["jpy_est"] = df["jpy_est"].astype(float)
    print(f"  {len(df)}行（{df['date'].min().date()}〜{df['date'].max().date()}）")
    return df


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    price_history = fetch_r2_price_history()
    price_history = price_history.sort_values(["oracle_id", "date"])

    print(
        f"\n価格履歴取得完了: {len(price_history)}行、"
        f"{price_history['date'].min().date()}〜{price_history['date'].max().date()}、"
        f"{price_history['oracle_id'].nunique()}オラクル"
    )

    price_history.to_parquet(DATA_DIR / "price_history.parquet", index=False)
    fetch_supabase_usage_stats().to_parquet(DATA_DIR / "usage_stats.parquet", index=False)

    static_attrs = pd.concat(
        [fetch_supabase_static_attrs(), fetch_d1_catalog_static_attrs()], ignore_index=True
    ).drop_duplicates(subset="oracle_id", keep="first")
    static_attrs.to_parquet(DATA_DIR / "static_attrs.parquet", index=False)
    print(f"\n{DATA_DIR} にキャッシュ保存しました。")


if __name__ == "__main__":
    main()
