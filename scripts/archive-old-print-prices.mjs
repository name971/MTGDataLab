/**
 * card_print_prices（Supabase、プリント単位・JSONB追記式）のうち、ARCHIVE_CUTOFF_DAYSより
 * 古い日付キーをCloudflare R2（print-price-history、月次NDJSON.gz、
 * scripts/lib/r2PriceArchive.mjs）へ移し、Supabase側のJSONBからは古いキーを取り除く。
 * 以前はCloudflare D1に書いていたが、D1無料枠の日次読み書き行数上限に達したため、
 * リクエスト数課金のR2へ移行した。
 *
 * プリント単位で約9.5万件、同じ「毎日追記」設計のためSupabase無料枠（500MB）を圧迫する。
 * 1プリント1行のJSONBに日付キーが追記されていく構造なので、行削除ではなく
 * 「JSONBから古いキーだけ取り除いてPATCHし直す」方式になる。
 *
 * getLatestPricesForPrints（src/lib/dbCardPrintPrices.ts、「その他のプリント」欄の価格表示・
 * 代表画像選定）は各プリントの最新日の値しか見ないため、古い日付を取り除いても影響しない。
 * 個別プリントの価格推移グラフ（getPrintPriceHistory）だけが全履歴を必要とするため、
 * そちらはR2アーカイブと結合して表示する（同ファイル参照）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/archive-old-print-prices.mjs
 */

import { mergePrintPriceRows } from "./lib/r2PriceArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// streak計算（scripts/compute-card-streaks.mjs）が必要とする直近60日はSupabase側に
// 残しておく必要があるため、それより古い分だけをこのカットオフで吸い出す。
const ARCHIVE_CUTOFF_DAYS = 60;
const PAGE_SIZE = 1000;

async function supabaseGetAll(path) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function supabasePatch(path, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
}

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_CUTOFF_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  console.log(`card_print_pricesを取得中（${cutoffStr}より古い日付キーを対象）...`);
  const printRows = await supabaseGetAll("card_print_prices?select=scryfall_id,prices,prices_foil");
  console.log(`対象プリント: ${printRows.length}件`);

  const archiveRows = [];
  const trimmedRows = []; // { scryfall_id, prices, prices_foil } のうち実際にキーを削った行だけ

  for (const row of printRows) {
    const prices = row.prices ?? {};
    const pricesFoil = row.prices_foil ?? {};
    const allDates = new Set([...Object.keys(prices), ...Object.keys(pricesFoil)]);
    const oldDates = [...allDates].filter((d) => d < cutoffStr);
    if (oldDates.length === 0) continue;

    const newPrices = { ...prices };
    const newPricesFoil = { ...pricesFoil };
    for (const date of oldDates) {
      archiveRows.push({
        scryfall_id: row.scryfall_id,
        date,
        usd: prices[date] ?? null,
        usd_foil: pricesFoil[date] ?? null,
      });
      delete newPrices[date];
      delete newPricesFoil[date];
    }
    trimmedRows.push({ scryfall_id: row.scryfall_id, prices: newPrices, prices_foil: newPricesFoil });
  }

  console.log(`アーカイブ対象: ${archiveRows.length}件（日付キー単位）、${trimmedRows.length}プリント分`);
  if (archiveRows.length === 0) {
    console.log("アーカイブ対象がありません。終了します。");
    return;
  }

  // R2のPutObjectは書き込み後すぐ読める強い一貫性があるため（D1のレプリカ遅延と違い）、
  // mergePrintPriceRowsが例外を投げずに完了すれば、そのままSupabase側の削除に進んでよい。
  console.log("R2（print-price-history）へ書き込み中...");
  await mergePrintPriceRows(archiveRows);

  console.log("Supabase側のJSONBから古い日付キーを削除中...");
  const PATCH_CONCURRENCY = 8;
  for (let i = 0; i < trimmedRows.length; i += PATCH_CONCURRENCY) {
    const chunk = trimmedRows.slice(i, i + PATCH_CONCURRENCY);
    await Promise.all(
      chunk.map((r) =>
        supabasePatch(`card_print_prices?scryfall_id=eq.${r.scryfall_id}`, {
          prices: r.prices,
          prices_foil: r.prices_foil,
        }),
      ),
    );
    console.log(`  ...${Math.min(i + PATCH_CONCURRENCY, trimmedRows.length)}/${trimmedRows.length}プリント`);
  }

  console.log(
    `\n完了: ${archiveRows.length}件（${trimmedRows.length}プリント分）をR2へアーカイブし、Supabase側のJSONBを間引きました。`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
