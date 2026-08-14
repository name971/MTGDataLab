"""
【一時利用・使い捨てスクリプト】TCGCSV（https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z、
2024-02-08以降の日次アーカイブ）から、Magic全カードのUSD市場価格を取得し、
Cloudflare R2（月次Parquetファイル、S3互換API）へ書き込む。

D1ではなくR2にした理由: D1は無料枠でも1日あたりの読み書き行数に上限があり
（読み取り500万行/日、書き込み10万行/日）、この規模のバックフィル・学習データ取得で
簡単に使い切ってしまう（実際に使い切った）。R2は「行数」でなく「リクエスト回数」で
課金されるため、月次ファイルにまとめておけば読み書きのたびに数百万行を消費することがない
（全カード×2.5年分でもParquet圧縮で数百MB程度、無料枠10GBに対して十分余裕がある）。

ファイル1つ = 1ヶ月分、(oracle_id, date, jpy_est)の全カード分。既存ファイルがあれば
マージしてから書き戻す（日付重複時は今回の取得値で上書き）。

実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=...
      CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
      python ml/fetch_tcgcsv_history.py [--start YYYY-MM-DD] [--end YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import shutil
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

import boto3
import pandas as pd
import py7zr
import requests

from fetch_data import d1_query, supabase_get_all

DATA_DIR = Path(__file__).parent / "data"
IDENTIFIERS_CACHE = DATA_DIR / "cache" / "AllIdentifiers.json"

MTG_CATEGORY_ID = "1"
ARCHIVE_START_DATE = date(2024, 2, 8)
REAL_ARCHIVE_START_DATE = "2026-07-25"  # これ以降は自前の実データ（D1）があるので触らない

R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME")
R2_PREFIX = "price-history"
R2_PRINT_PREFIX = "print-price-history"


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def build_product_id_to_scryfall_id() -> dict[str, str]:
    if not IDENTIFIERS_CACHE.exists():
        # 日次実行等、ml/fetch_data.pyを事前に実行していない環境向けに自前でダウンロードする
        from fetch_data import _download_and_cache_zip, MTGJSON_IDENTIFIERS_URL

        _download_and_cache_zip(MTGJSON_IDENTIFIERS_URL, "AllIdentifiers.json")
    data = json.loads(IDENTIFIERS_CACHE.read_text(encoding="utf-8"))
    mapping: dict[str, str] = {}
    for card in data["data"].values():
        ids = card.get("identifiers") or {}
        product_id = ids.get("tcgplayerProductId")
        scryfall_id = ids.get("scryfallId")
        if product_id and scryfall_id:
            mapping[str(product_id)] = scryfall_id
    print(f"MTGJSON: {len(mapping)}件のtcgplayerProductId→scryfallId対応")
    return mapping


def build_candidate_scryfall_to_oracle() -> dict[str, str]:
    """全カードのscryfall_id -> oracle_id対応を作る（Postgres card_prints全件 + D1
    catalog_oracles.representative_scryfall_id）。R2は行数でなくリクエスト回数課金で
    無料枠も余裕があるため、D1の時のような候補カード限定は行わない。"""
    print("Postgres: card_prints（全プリント）を取得中...")
    print_rows = supabase_get_all("card_prints?select=scryfall_id,oracle_id")
    print_df = pd.DataFrame(print_rows)
    print(f"  {len(print_df)}件")

    print("D1: catalog_oracles（デッキ未使用カードの代表プリント）を取得中...")
    d1_rows = d1_query("SELECT oracle_id, representative_scryfall_id FROM catalog_oracles", [])
    print(f"  {len(d1_rows)}件")

    scryfall_to_oracle: dict[str, str] = {}
    if not print_df.empty:
        for row in print_df.itertuples():
            scryfall_to_oracle[row.scryfall_id] = row.oracle_id
    for row in d1_rows:
        scryfall_to_oracle[row["representative_scryfall_id"]] = row["oracle_id"]

    print(f"対象プリント: {len(scryfall_to_oracle)}件（オラクル単位ではもっと少ない）")
    return scryfall_to_oracle


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


# プリント単位のデータも扱うようになりJSON解析・辞書構築（CPU律速）の量が増えたため、
# ThreadPoolExecutorだとPythonのGILでCPU処理部分が事実上直列化され、体感で8倍以上遅くなった
# （ダウンロード=I/O待ちだけがスレッドで並列化され、JSON解析はどのみち1コアで回っていたため）。
# ProcessPoolExecutorで実プロセスに分けて真の並列化をする。ワーカーごとに一度だけ
# 巨大な対応表（scryfall_by_product_id等）をグローバルへ持たせ、タスクごとの再pickleを避ける。
_worker_scryfall_by_product_id: dict[str, str] = {}
_worker_oracle_by_scryfall: dict[str, str] = {}


def _init_worker(scryfall_by_product_id: dict[str, str], oracle_by_scryfall: dict[str, str]) -> None:
    global _worker_scryfall_by_product_id, _worker_oracle_by_scryfall
    _worker_scryfall_by_product_id = scryfall_by_product_id
    _worker_oracle_by_scryfall = oracle_by_scryfall


def _fetch_one_day_worker(day: date) -> tuple[dict[str, float], dict[str, float]]:
    return fetch_one_day(day, _worker_scryfall_by_product_id, _worker_oracle_by_scryfall)


def fetch_one_day(
    day: date, scryfall_by_product_id: dict[str, str], oracle_by_scryfall: dict[str, str]
) -> tuple[dict[str, float], dict[str, float]]:
    """1日分のアーカイブから、(オラクル単位の最安値, プリント単位の価格) をそれぞれ
    scryfall_id/oracle_id -> usd の辞書で返す。見つからなければ両方とも空辞書。
    接続エラー（並列アクセスでtcgcsv.com側に接続をリセットされることが実際にあった）は
    数回リトライし、リトライしても失敗したら諦めてその日はスキップする（1日分の失敗で
    ワーカープール全体・スクリプト全体を巻き込んでクラッシュさせない）。"""
    url = f"https://tcgcsv.com/archive/tcgplayer/prices-{day.isoformat()}.ppmd.7z"
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            res = requests.get(
                url, timeout=120, headers={"User-Agent": "Mozilla/5.0 (compatible; jp-mtgstocks/0.1)"}
            )
            break
        except requests.exceptions.RequestException as err:
            last_error = err
            time.sleep(3 * (attempt + 1))
    else:
        print(f"  {day.isoformat()}: 接続エラーのため諦めます（{last_error}）", flush=True)
        return {}, {}

    if res.status_code in (401, 403, 404):
        return {}, {}
    res.raise_for_status()

    tmp_dir = tempfile.mkdtemp(prefix="tcgcsv-")
    try:
        with py7zr.SevenZipFile(io.BytesIO(res.content), mode="r") as archive:
            archive.extractall(path=tmp_dir)

        mtg_dir = Path(tmp_dir) / day.isoformat() / MTG_CATEGORY_ID
        if not mtg_dir.exists():
            return {}, {}

        best_by_oracle: dict[str, float] = {}
        usd_by_print: dict[str, float] = {}
        for prices_file in mtg_dir.glob("*/prices"):
            body = json.loads(prices_file.read_text(encoding="utf-8"))
            for row in body.get("results", []):
                if row.get("subTypeName") != "Normal":
                    continue
                market = row.get("marketPrice")
                if market is None:
                    continue
                scryfall_id = scryfall_by_product_id.get(str(row["productId"]))
                if not scryfall_id:
                    continue
                usd = float(market)
                usd_by_print[scryfall_id] = usd

                oracle_id = oracle_by_scryfall.get(scryfall_id)
                if not oracle_id:
                    continue
                if oracle_id not in best_by_oracle or usd < best_by_oracle[oracle_id]:
                    best_by_oracle[oracle_id] = usd
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return best_by_oracle, usd_by_print


def fetch_exchange_rates() -> dict[str, float]:
    rows = supabase_get_all("exchange_rates?select=date,usd_to_jpy&order=date.asc")
    return {r["date"]: float(r["usd_to_jpy"]) for r in rows}


def resolve_rate(day_str: str, sorted_dates: list[str], rate_by_date: dict[str, float]) -> float | None:
    """為替市場の休日（土日等）は直近の平日レートで代用する。"""
    best = None
    for d in sorted_dates:
        if d <= day_str:
            best = d
        else:
            break
    return rate_by_date.get(best) if best else None


def sync_month_to_r2(s3, key: str, new_rows: pd.DataFrame, id_column: str) -> None:
    """R2上の月次NDJSON.gzファイルを読み込み（無ければ空扱い）、新しい行とマージして書き戻す。
    (id_column, date)が重複する場合は今回取得した値を優先する。

    Parquetではなくgzip圧縮NDJSON（1行1レコードのJSON）にしている理由: サイト側
    （Cloudflare Workers）での読み込みにhyparquet（Parquetパーサー）を使ったところ、
    OpenNextのビルドが全ルート共通の1つのWorkerバンドルにコードをまとめる関係で、
    無関係なルート（検索等）まで巻き込んでCPU時間制限（無料プラン10ms）を超過させる
    事故が実際に発生した。NDJSON.gzならWorkers標準のDecompressionStream（追加ライブラリ
    不要、素のWeb API）だけで読めるため、バンドルサイズへの影響を最小限にできる。"""
    try:
        obj = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)
        with gzip.GzipFile(fileobj=io.BytesIO(obj["Body"].read())) as gz:
            existing_records = [json.loads(line) for line in gz if line.strip()]
        existing = pd.DataFrame(existing_records) if existing_records else new_rows.iloc[0:0]
    except s3.exceptions.NoSuchKey:
        existing = new_rows.iloc[0:0]

    merged = pd.concat([existing, new_rows], ignore_index=True)
    merged = merged.drop_duplicates(subset=[id_column, "date"], keep="last")
    merged = merged.sort_values([id_column, "date"])

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        for record in merged.to_dict(orient="records"):
            gz.write((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
    buf.seek(0)
    s3.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=buf.getvalue())
    print(f"  R2へ書き込み: {key}（{len(merged)}行）")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=str, default=ARCHIVE_START_DATE.isoformat())
    parser.add_argument("--end", type=str, default=date.today().isoformat())
    args = parser.parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)

    if not R2_BUCKET_NAME:
        raise SystemExit("R2_BUCKET_NAME等のR2関連の環境変数を設定してください")
    s3 = r2_client()

    scryfall_by_product_id = build_product_id_to_scryfall_id()
    oracle_by_scryfall = build_candidate_scryfall_to_oracle()
    candidate_oracle_count = len(set(oracle_by_scryfall.values()))
    print(f"候補オラクル数: {candidate_oracle_count}件")

    print("Supabase: exchange_rates を取得中...")
    rate_by_date = fetch_exchange_rates()
    sorted_rate_dates = sorted(rate_by_date.keys())
    print(f"  {len(rate_by_date)}件（{sorted_rate_dates[0]}〜{sorted_rate_dates[-1]}）")

    all_days = [d for d in daterange(start, end) if d.isoformat() < REAL_ARCHIVE_START_DATE]
    # 月ごとにまとめてR2へ書き込む（sync_month_to_r2が既存ファイルを読んでマージするため、
    # 同じ月を並列で書き込むと競合するので、月内の日付だけ並列化し、月をまたぐ処理は逐次にする）
    days_by_month: dict[str, list[date]] = {}
    for d in all_days:
        days_by_month.setdefault(month_key(d), []).append(d)

    print(f"対象: {len(all_days)}日分、{len(days_by_month)}ヶ月分", flush=True)
    total_rows_fetched = 0
    total_print_rows_fetched = 0
    MAX_WORKERS = 8

    with ProcessPoolExecutor(
        max_workers=MAX_WORKERS,
        initializer=_init_worker,
        initargs=(scryfall_by_product_id, oracle_by_scryfall),
    ) as pool:
        for month, days in sorted(days_by_month.items()):
            month_buffer: list[dict] = []
            print_month_buffer: list[dict] = []
            future_to_day = {pool.submit(_fetch_one_day_worker, d): d for d in days}
            for future in as_completed(future_to_day):
                d = future_to_day[future]
                day_str = d.isoformat()
                usd_by_oracle, usd_by_print = future.result()
                if not usd_by_oracle and not usd_by_print:
                    print(f"  {day_str}: データ無し", flush=True)
                    continue
                rate = resolve_rate(day_str, sorted_rate_dates, rate_by_date)
                if not rate:
                    print(f"  {day_str}: 為替レートが無いためスキップ", flush=True)
                    continue
                for oracle_id, usd in usd_by_oracle.items():
                    month_buffer.append({"oracle_id": oracle_id, "date": day_str, "jpy_est": round(usd * rate, 2)})
                for scryfall_id, usd in usd_by_print.items():
                    print_month_buffer.append({"scryfall_id": scryfall_id, "date": day_str, "usd": usd})
                total_rows_fetched += len(usd_by_oracle)
                total_print_rows_fetched += len(usd_by_print)
                print(f"  {day_str}: オラクル{len(usd_by_oracle)}件・プリント{len(usd_by_print)}件取得", flush=True)

            if month_buffer:
                sync_month_to_r2(s3, f"{R2_PREFIX}/{month}.ndjson.gz", pd.DataFrame(month_buffer), "oracle_id")
            if print_month_buffer:
                sync_month_to_r2(
                    s3, f"{R2_PRINT_PREFIX}/{month}.ndjson.gz", pd.DataFrame(print_month_buffer), "scryfall_id"
                )

    print(
        f"\n完了。オラクル単位{total_rows_fetched}件（{R2_PREFIX}/）・プリント単位{total_print_rows_fetched}件"
        f"（{R2_PRINT_PREFIX}/）をR2（{R2_BUCKET_NAME}）へバックフィルしました。",
        flush=True,
    )


if __name__ == "__main__":
    main()
