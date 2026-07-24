/**
 * card_usage_stats（フォーマット別・カード別の採用率）と
 * archetype_price_stats（アーキタイプ別デッキ価格の中央値）を
 * decks / deck_cards / card_price_snapshots の実データから計算して保存する。
 *
 * db/schema.sql 8章のコメントに書かれた集計ロジックのJS実装版
 * （anonキーではraw SQLのCTEクエリを実行できないため、アプリ側で計算してUPSERTする）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-deck-stats.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const PERIOD_DAYS = 30;
const ARCHETYPE_DECK_WINDOW = 20; // アーキタイプごとに直近何件を集計対象にするか

const PAGE_SIZE = 1000; // PostgRESTのデフォルト最大行数（db-max-rows）に合わせてページングする

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

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  // decks + tournaments(format) + deck_cards(main)
  const decks = await supabaseGet(
    "decks?select=id,archetype_id,created_at,tournaments!inner(format),deck_cards(card_name,oracle_id,quantity,board)"
  );
  console.log(`対象デッキ: ${decks.length}件`);

  // card_price_snapshots（本日分、'en'系列）を oracle_id -> jpy_est でマップ化
  const snapshots = await supabaseGet(
    `card_price_snapshots?select=oracle_id,jpy_est&series=eq.en&date=eq.${today}`
  );
  const priceByOracle = new Map(snapshots.map((s) => [s.oracle_id, Number(s.jpy_est)]));
  console.log(`本日の価格スナップショット: ${priceByOracle.size}件`);

  // ── card_usage_stats: フォーマット別・オラクルID別の採用率 ──
  const formatDeckCount = new Map(); // format -> total decks
  const formatOracleDeckCount = new Map(); // "format|oracle_id" -> decks containing it (main only)

  for (const deck of decks) {
    const format = deck.tournaments?.format;
    if (!format) continue;
    formatDeckCount.set(format, (formatDeckCount.get(format) ?? 0) + 1);

    const mainOracleIds = new Set(
      deck.deck_cards
        .filter((c) => c.board === "main" && c.oracle_id)
        .map((c) => c.oracle_id)
    );
    for (const oracleId of mainOracleIds) {
      const key = `${format}|${oracleId}`;
      formatOracleDeckCount.set(key, (formatOracleDeckCount.get(key) ?? 0) + 1);
    }
  }

  const usageRows = [];
  for (const [key, count] of formatOracleDeckCount) {
    const [format, oracleId] = key.split("|");
    const totalDecks = formatDeckCount.get(format) ?? 0;
    if (totalDecks === 0) continue;
    usageRows.push({
      format,
      oracle_id: oracleId,
      period_days: PERIOD_DAYS,
      usage_rate: Math.round((count / totalDecks) * 10000) / 100,
      deck_sample_size: totalDecks,
      calculated_at: today,
    });
  }
  await supabaseUpsert("card_usage_stats", usageRows, "format,oracle_id,period_days,calculated_at");
  console.log(`card_usage_stats 保存: ${usageRows.length}件`);

  // ── archetype_price_stats: アーキタイプ別デッキ価格の中央値 ──
  const decksByArchetype = new Map(); // archetype_id -> deck[]
  for (const deck of decks) {
    if (!deck.archetype_id) continue;
    if (!decksByArchetype.has(deck.archetype_id)) decksByArchetype.set(deck.archetype_id, []);
    decksByArchetype.get(deck.archetype_id).push(deck);
  }

  const priceRows = [];
  for (const [archetypeId, archetypeDecks] of decksByArchetype) {
    const recentDecks = [...archetypeDecks]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, ARCHETYPE_DECK_WINDOW);

    const deckTotals = [];
    for (const deck of recentDecks) {
      let total = 0;
      let hasAnyPrice = false;
      for (const card of deck.deck_cards) {
        if (card.board !== "main" || !card.oracle_id) continue;
        const price = priceByOracle.get(card.oracle_id);
        if (price == null) continue;
        hasAnyPrice = true;
        total += price * card.quantity;
      }
      if (hasAnyPrice) deckTotals.push(total);
    }

    if (deckTotals.length === 0) continue;
    priceRows.push({
      archetype_id: archetypeId,
      period_deck_count: ARCHETYPE_DECK_WINDOW,
      median_price_jpy: Math.round(median(deckTotals) * 100) / 100,
      sample_size: deckTotals.length,
      calculated_at: today,
    });
  }
  await supabaseUpsert("archetype_price_stats", priceRows, "archetype_id,calculated_at");
  console.log(`archetype_price_stats 保存: ${priceRows.length}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
