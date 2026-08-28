/**
 * deck_cards（scripts/import-tournaments.mjsで投入済み）のうちoracle_idが未解決な
 * カード名を集め、Scryfallのバルクデータから取得してcard_oracles/cardsに投入する。
 * 投入後、deck_cards.oracle_idを埋め直す。
 *
 * 名前が解決できたカードは、そのcard_name完全一致でdeck_cardsを直接PATCHする
 * （resolve_oracle_id RPCは名前の類似度でマッチするため、"Petty Theft"→"Brazen Borrower"
 * のような両面カードの裏面名を表面名に紐付けることができない。完全一致で解決できな
 * かった残りだけ、表記ゆれ吸収のためにRPCへフォールバックする）。
 *
 * import-sample-cards.mjsとの違い: 対象カードのリストをハードコードではなく
 * deck_cardsの実データから動的に集める（実際のトーナメント環境に追従できる）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/import-deck-cards.mjs
 */

import {
  ensureBulkData,
  loadIndex,
  findEnglishCard,
  findJapanesePrint,
  findAnyJapaneseName,
  frontFaceName,
  frontFacePrintedName,
  combinedOracleText,
  toCardRow,
} from "./lib/scryfallBulk.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PAGE_SIZE = 1000; // PostgRESTのデフォルト最大行数（db-max-rows）に合わせてページングする
// card_oracles/cardsへのupsertは1000件だと毎回statement timeoutになる
// （2026-08-27、oracle_text等サイズの大きい列があり書き込みが重いため）。書き込みは
// 読み取りページングより小さく刻む。
const UPSERT_CHUNK_SIZE = 200;

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
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
}

// GitHub Actionsランナー〜Supabase間で稀に一瞬だけ接続が切れる（ECONNRESET等）ことがあり、
// 逐次実行だと1回のネットワーク瞬断でジョブ全体が落ちて未解決分が翌日以降に持ち越されてしまう。
// 一時的なネットワークエラーだけ数回リトライする。
async function withRetry(fn, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

// deck_cards.oracle_idの解決はカード名/行ごとに1リクエストのため、逐次実行だと
// 未解決件数が多い日にCIのタイムアウト内で終わらないことがある。同時実行数を絞りつつ
// 並列化して所要時間を短縮する。
async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function runNext() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

async function supabasePatch(path, body) {
  await withRetry(async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
  });
}

async function main() {
  await ensureBulkData();
  const index = await loadIndex();

  const unresolved = await supabaseGet("deck_cards?select=card_name&oracle_id=is.null&order=id.asc");
  const names = [...new Set(unresolved.map((r) => r.card_name))];
  console.log(`未解決カード名: ${names.length}件`);

  let imported = 0;
  let notFound = 0;
  const cardOracleRows = [];
  const cardRows = [];
  const resolvedNames = []; // { name, oracleId } — 完全一致で解決できた名前（PATCH対象）

  for (const name of names) {
    const enCard = findEnglishCard(index, name);
    if (!enCard) {
      console.error(`✗ ${name}: バルクデータで見つからず`);
      notFound++;
      continue;
    }
    const jaCard = findJapanesePrint(index, enCard.oracle_id, enCard.set, enCard.collector_number);
    // 同一プリントの日本語版が無くても、名前だけは他プリントの日本語版から拾う
    // （代表英語版がSecret Lair/デジタル専用版等で日本語版が対応しないことがあるため）。
    const printedNameJa = jaCard ? frontFacePrintedName(jaCard) : findAnyJapaneseName(index, enCard.oracle_id);

    cardOracleRows.push({
      oracle_id: enCard.oracle_id,
      name: frontFaceName(enCard),
      printed_name_ja: printedNameJa,
      oracle_text: combinedOracleText(enCard),
      // 代表プリント1件だけの判定（reservedは全プリント共通なので正確、is_serializedは
      // 別プリントがシリアル版のケースを見落としうる近似値。厳密な集約は
      // scripts/backfill-reserved-serialized.mjs側で定期的に行う）
      is_reserved: enCard.reserved ?? false,
      is_serialized: enCard.promo_types?.includes("serialized") ?? false,
    });
    cardRows.push(toCardRow(enCard, enCard.oracle_id));
    if (jaCard) cardRows.push(toCardRow(jaCard, enCard.oracle_id));
    resolvedNames.push({ name, oracleId: enCard.oracle_id });

    imported++;
    if (imported % 100 === 0) console.log(`  ...${imported}件処理済み`);
  }

  // 表裏どちらの面名からも同じoracle_id/scryfall_idに解決されることがあるため、
  // 1回のUPSERT内で同じキーが重複しないよう名寄せしてから送る
  const dedupedOracleRows = [...new Map(cardOracleRows.map((r) => [r.oracle_id, r])).values()];
  const dedupedCardRows = [...new Map(cardRows.map((r) => [r.scryfall_id, r])).values()];

  // バルクデータのローカル検索はレート制限が無いため、DB書き込みだけまとめて送る
  for (let i = 0; i < dedupedOracleRows.length; i += UPSERT_CHUNK_SIZE) {
    await withRetry(() => supabaseUpsert("card_oracles", dedupedOracleRows.slice(i, i + UPSERT_CHUNK_SIZE), "oracle_id"));
  }
  for (let i = 0; i < dedupedCardRows.length; i += UPSERT_CHUNK_SIZE) {
    await withRetry(() => supabaseUpsert("cards", dedupedCardRows.slice(i, i + UPSERT_CHUNK_SIZE), "scryfall_id"));
  }

  console.log(`\ncard_oracles投入: ${imported}件成功、${notFound}件未検出`);

  // deck_cards.oracle_idを埋め直す（1. 完全一致で解決できた名前を直接PATCH）
  console.log("deck_cards.oracle_id を解決中（完全一致）...");
  let exactResolved = 0;
  await runWithConcurrency(resolvedNames, 20, async ({ name, oracleId }) => {
    try {
      // oracle_id解決後はcard_name（card_oracles.nameの完全な重複、db/schema.sql参照）を
      // NULLにして容量を節約する。読み取り側はcard_name ?? card_oracles.nameで表示する。
      await supabasePatch(
        `deck_cards?card_name=eq.${encodeURIComponent(name)}&oracle_id=is.null`,
        { oracle_id: oracleId, card_name: null },
      );
      exactResolved++;
      if (exactResolved % 100 === 0) console.log(`  ...${exactResolved}件処理済み`);
    } catch (err) {
      // 1件の恒久的なエラー（リトライしても直らないもの）でジョブ全体を落とさない。
      // 未解決のまま残った分は次回の実行で自然にリトライされる。
      console.error(`✗ ${name}: PATCH失敗（次回実行時に再試行） ${err.message}`);
    }
  });
  console.log(`完全一致で解決: ${exactResolved}件のカード名分`);

  // 2. それでも残った分だけ、表記ゆれ吸収のためfuzzy検索RPCへフォールバック
  console.log("deck_cards.oracle_id を再解決中（fuzzy）...");
  const stillUnresolved = await supabaseGet(
    "deck_cards?select=id,card_name&oracle_id=is.null",
  );
  let resolved = 0;
  await runWithConcurrency(stillUnresolved, 20, async (row) => {
    try {
      const rpcRows = await withRetry(async () => {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_oracle_id`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input_name: row.card_name.trim().toLowerCase() }),
        });
        if (!res.ok) throw new Error(`RPC resolve_oracle_id failed: ${res.status} ${await res.text()}`);
        return res.json();
      });
      const oracleId = rpcRows[0]?.oracle_id;
      if (oracleId) {
        await supabasePatch(`deck_cards?id=eq.${row.id}`, { oracle_id: oracleId, card_name: null });
        resolved++;
      }
    } catch (err) {
      // 1件の恒久的なエラーでジョブ全体を落とさない。未解決のまま残った分は次回の実行で再試行される。
      console.error(`✗ ${row.card_name}: fuzzy解決失敗（次回実行時に再試行） ${err.message}`);
    }
  });
  console.log(`deck_cards.oracle_id 解決: ${resolved}/${stillUnresolved.length}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
