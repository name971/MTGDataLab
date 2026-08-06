/**
 * card_print_prices（全プリントの日次価格履歴、scripts/snapshot-print-prices.mjsが日次追記）から、
 * オラクル単位・日付単位で「その日、全プリント中の最安値」を計算し、
 * card_cheapest_price_snapshots（db/schema.sql）に保存する。
 *
 * 「代表プリント」（scripts/rebuild-card-prints.mjs、新セット追加時にしか選び直さない）と違い、
 * 毎日全プリントを横断して見るため、実際に今一番安く買えるプリントの価格を遅延なく反映できる。
 * カード詳細ページのメイン価格・グラフはこちらを見る。
 *
 * snapshot-print-prices.mjsは差分方式（前日と同じ値なら日付キーを書かない）に変更したため、
 * ここでは「値が書かれていない日＝前回書かれた値のまま」とみなすforward fillをしてから
 * 日付ごとの最安値を計算する（そうしないと、値が変わらず書き込みが無かったプリントが
 * その日の最安値候補から漏れ、実際より高い価格を「最安値」として記録してしまう）。
 *
 * 全期間を毎回計算し直す設計（card_print_pricesのJSONBは日数分しか無くまだ軽いため）。
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-cheapest-price-snapshots.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000;

async function supabaseGet(path) {
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

async function supabaseUpsert(table, rows, conflictColumn) {
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  console.log("為替レートを取得中...");
  const rateRows = await supabaseGet("exchange_rates?select=date,usd_to_jpy&order=date.asc");
  const usdToJpyByDate = new Map(rateRows.map((r) => [r.date, Number(r.usd_to_jpy)]));
  // 為替レート取得（Frankfurter API）がその日だけ失敗する等でexchange_ratesにその日の行が
  // 無いと、usdはあるのにjpy_estだけ永続的にnullになり、card_print_prices（USD）と
  // card_cheapest_price_snapshots（JPY）の間に恒久的な剥離が残る。日付ソート済みの配列から
  // 二分探索的に「その日以前で一番近い日」のレートを暫定値として使い、この剥離を防ぐ
  // （src/lib/dbCardPrintPrices.tsの表示側フォールバックと同じ考え方）。
  const sortedRateDates = rateRows.map((r) => r.date).sort();
  function rateAtOrBefore(date) {
    let lo = 0;
    let hi = sortedRateDates.length - 1;
    let result = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedRateDates[mid] <= date) {
        result = sortedRateDates[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result ? usdToJpyByDate.get(result) : undefined;
  }

  console.log("使用不可プリントの一覧を取得中...");
  const notLegalRows = await supabaseGet(
    "card_prints?not_tournament_legal=eq.true&select=scryfall_id",
  );
  const notTournamentLegalIds = new Set(notLegalRows.map((r) => r.scryfall_id));
  console.log(`${notTournamentLegalIds.size}件が使用不可プリント（最安値集計から除外）`);

  console.log("全プリントの価格履歴を取得中...");
  const printPriceRows = await supabaseGet(
    "card_print_prices?select=scryfall_id,oracle_id,prices,prices_foil",
  );
  console.log(`${printPriceRows.length}件のプリント価格履歴を走査`);

  // 差分方式で書かれたJSONBを前提に、全プリントを横断した「その日時点で有効な日付」の
  // 一覧を作る（誰かしら値を書いた日＝実際にバッチが動いた日、という前提で十分カバーできる）。
  const allDates = new Set();
  for (const row of printPriceRows) {
    for (const d of Object.keys(row.prices ?? {})) allDates.add(d);
    for (const d of Object.keys(row.prices_foil ?? {})) allDates.add(d);
  }
  const sortedDates = [...allDates].sort();

  // oracle_id -> date -> { usd, scryfallId } の最安値を集計
  // 金縁(World Championship Decks等)・銀縁(Un-set)等のトーナメント使用不可プリントは
  // 実際には買っても使えないため「最安値」の候補から除外する（代表プリント選定と同じ方針）。
  const bestNormalByOracleDate = new Map();
  const bestFoilByOracleDate = new Map();

  /**
   * 1プリント分の疎な{date: usd}を、sortedDates全体にforward fillしてから、
   * 各日付をbestByOracleDateの最安値候補として反映する。
   */
  function forwardFillAndAccumulate(row, priceObj, bestByOracleDate) {
    const ownDates = Object.keys(priceObj).sort();
    if (ownDates.length === 0) return;
    let ownIdx = 0;
    let current = null;
    for (const date of sortedDates) {
      while (ownIdx < ownDates.length && ownDates[ownIdx] <= date) {
        current = priceObj[ownDates[ownIdx]];
        ownIdx++;
      }
      if (current == null) continue; // まだこのプリントの最初の価格記録日に達していない
      const key = `${row.oracle_id}|${date}`;
      const existing = bestByOracleDate.get(key);
      if (!existing || current < existing.usd) {
        bestByOracleDate.set(key, { oracleId: row.oracle_id, date, usd: current, scryfallId: row.scryfall_id });
      }
    }
  }

  for (const row of printPriceRows) {
    if (notTournamentLegalIds.has(row.scryfall_id)) continue;
    forwardFillAndAccumulate(row, row.prices ?? {}, bestNormalByOracleDate);
    forwardFillAndAccumulate(row, row.prices_foil ?? {}, bestFoilByOracleDate);
  }

  // normal/foilを oracle_id+date でマージして1行にする
  const merged = new Map();
  for (const [key, v] of bestNormalByOracleDate) {
    merged.set(key, { oracleId: v.oracleId, date: v.date, normal: v, foil: null });
  }
  for (const [key, v] of bestFoilByOracleDate) {
    const existing = merged.get(key);
    if (existing) existing.foil = v;
    else merged.set(key, { oracleId: v.oracleId, date: v.date, normal: null, foil: v });
  }

  const rows = [...merged.values()].map((m) => {
    const rate = rateAtOrBefore(m.date);
    return {
      oracle_id: m.oracleId,
      date: m.date,
      scryfall_id: m.normal?.scryfallId ?? null,
      usd: m.normal?.usd ?? null,
      jpy_est: m.normal && rate ? Math.round(m.normal.usd * rate * 100) / 100 : null,
      scryfall_id_foil: m.foil?.scryfallId ?? null,
      usd_foil: m.foil?.usd ?? null,
      jpy_est_foil: m.foil && rate ? Math.round(m.foil.usd * rate * 100) / 100 : null,
    };
  });

  console.log(`${rows.length}件（オラクル×日付）の最安値スナップショットを保存中...`);
  await supabaseUpsert("card_cheapest_price_snapshots", rows, "oracle_id,date");
  console.log("完了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
