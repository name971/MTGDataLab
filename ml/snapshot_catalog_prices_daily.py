"""
Magic全カード（デッキ未使用カタログ含む）の「今日の価格」をTCGCSVから取得し、R2の当月
Parquetファイルに追記する（日次実行想定）。ml/fetch_tcgcsv_history.pyの一部関数を再利用する。

なぜD1でなくR2か: D1は無料枠でも1日あたりの読み書き行数に上限があり（読み取り500万行/日、
書き込み10万行/日）、全カード分（8万件超のプリント）を毎日書き込むには向かない。R2は
「リクエスト回数」課金なので、月次ファイル1回の読み書きで済む今の設計なら問題にならない。

実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=...
      CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
      python ml/snapshot_catalog_prices_daily.py
"""

from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from fetch_tcgcsv_history import (
    R2_PREFIX,
    R2_PRINT_PREFIX,
    build_candidate_scryfall_to_oracle,
    build_product_id_to_scryfall_id,
    fetch_exchange_rates,
    fetch_one_day,
    month_key,
    r2_client,
    resolve_rate,
    sync_month_to_r2,
)


def main() -> None:
    scryfall_by_product_id = build_product_id_to_scryfall_id()
    oracle_by_scryfall = build_candidate_scryfall_to_oracle()

    rate_by_date = fetch_exchange_rates()
    sorted_rate_dates = sorted(rate_by_date.keys())

    s3 = r2_client()

    # TCGCSVのアーカイブは当日分が生成されるまで少しラグがあることがあるため、
    # 今日分が無ければ前日分を試す
    for day in (date.today(), date.today() - timedelta(days=1)):
        day_str = day.isoformat()
        usd_by_oracle, usd_by_print = fetch_one_day(day, scryfall_by_product_id, oracle_by_scryfall)
        if usd_by_oracle or usd_by_print:
            break
        print(f"{day_str}: データ無し、前日分を試します")
    else:
        print("直近2日分ともデータが取得できませんでした。")
        return

    rate = resolve_rate(day_str, sorted_rate_dates, rate_by_date)
    if not rate:
        raise SystemExit(f"{day_str}の為替レートが無いため中断します")

    month = month_key(day)
    oracle_rows = pd.DataFrame(
        [{"oracle_id": o, "date": day_str, "jpy_est": round(usd * rate, 2)} for o, usd in usd_by_oracle.items()]
    )
    print_rows = pd.DataFrame(
        [{"scryfall_id": s, "date": day_str, "usd": usd} for s, usd in usd_by_print.items()]
    )
    print(f"{day_str}: オラクル{len(oracle_rows)}件・プリント{len(print_rows)}件")

    if not oracle_rows.empty:
        sync_month_to_r2(s3, f"{R2_PREFIX}/{month}.parquet", oracle_rows, "oracle_id")
    if not print_rows.empty:
        sync_month_to_r2(s3, f"{R2_PRINT_PREFIX}/{month}.parquet", print_rows, "scryfall_id")

    print("完了")


if __name__ == "__main__":
    main()
