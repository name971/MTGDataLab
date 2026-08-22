/**
 * card_usage_stats（フォーマット別・カード別の採用率）と
 * archetype_price_stats（アーキタイプ別デッキ価格の中央値）を
 * decks / deck_cards / card_cheapest_price_snapshots の実データから計算して保存する。
 *
 * anonキーではraw SQLのCTEクエリを実行できないため、アプリ側で計算してUPSERTする。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/compute-deck-stats.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

// 90日は2026-08-20にDB容量対策で廃止（docs/incident-log.md参照）。deck_cards等の生データも
// 30日分だけ保持すればよくなった。
const PERIOD_DAYS_OPTIONS = [7, 30];
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

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`);
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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  // --date=YYYY-MM-DD で過去日付として計算できる（継続注目カードの3日連続判定に必要な
  // card_usage_stats の履歴を、待たずに過去分から一気に埋めるための後付けオプション。
  // ponytail: 未来日付や存在しないトーナメントデータの妥当性チェックはしない、手動実行前提）
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const today = dateArg ? dateArg.slice("--date=".length) : new Date().toISOString().slice(0, 10);

  // card_usage_stats（採用率）が実際に使う範囲は最大でもPERIOD_DAYS_OPTIONSの最大値（30日）分だけ。
  // それより古いデッキは絞り込み無しで取得しても集計に使われないため、データ量が増えると
  // （例: Commanderの大量バックフィルで一時的にdeck_cardsが数十万行に達した際）Supabase側の
  // クエリタイムアウトを起こす。必要な範囲だけサーバー側で絞り込んで取得する。
  const oldestNeededDate = new Date(today);
  oldestNeededDate.setDate(oldestNeededDate.getDate() - (Math.max(...PERIOD_DAYS_OPTIONS) - 1));
  const oldestNeededDateStr = isoDate(oldestNeededDate);

  // decks + tournaments(format, event_date)
  // 「直近N日」はトーナメント開催日（event_date）基準。deck自体のimport日時（created_at）
  // は取り込みタイミング依存でズレるため使わない。
  // deck_cardsは別クエリで取得する（1クエリにまとめてネスト取得すると、decks×deck_cardsの
  // JOINコストがデータ量増加時にPostgres側のstatement timeoutを超えてしまうため）。
  const deckMetas = await supabaseGet(
    "decks?select=id,archetype_id,created_at,tournaments!inner(format,event_date)" +
      `&tournaments.event_date=gte.${oldestNeededDateStr}`
  );
  console.log(`対象デッキ: ${deckMetas.length}件（${oldestNeededDateStr}以降）`);

  const deckCardsByDeckId = new Map();
  const DECK_ID_CHUNK = 200; // in.()のURL長・1クエリあたりの行数を抑えるため小分けにする
  for (let i = 0; i < deckMetas.length; i += DECK_ID_CHUNK) {
    const idsChunk = deckMetas.slice(i, i + DECK_ID_CHUNK).map((d) => d.id);
    const cards = await supabaseGet(
      `deck_cards?select=deck_id,oracle_id,quantity,board&deck_id=in.(${idsChunk.join(",")})`,
    );
    for (const c of cards) {
      if (!deckCardsByDeckId.has(c.deck_id)) deckCardsByDeckId.set(c.deck_id, []);
      deckCardsByDeckId.get(c.deck_id).push(c);
    }
  }
  const decks = deckMetas.map((d) => ({ ...d, deck_cards: deckCardsByDeckId.get(d.id) ?? [] }));

  // card_current_prices（1オラクル1行、全プリント横断の最安値の現在値キャッシュ）を
  // oracle_id -> jpy_est でマップ化（card_cheapest_price_snapshotsはD1移行済みで常に空のため使えない）
  const snapshots = await supabaseGet(`card_current_prices?select=oracle_id,jpy_est`);
  const priceByOracle = new Map(snapshots.map((s) => [s.oracle_id, Number(s.jpy_est)]));
  console.log(`本日の価格スナップショット: ${priceByOracle.size}件`);

  // ── card_usage_stats: フォーマット別・オラクルID別の採用率（7/30/90日それぞれ） ──
  const usageRows = [];
  for (const periodDays of PERIOD_DAYS_OPTIONS) {
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - (periodDays - 1));
    const cutoffStr = isoDate(cutoff);
    const decksInPeriod = decks.filter((d) => (d.tournaments?.event_date ?? "") >= cutoffStr);

    const formatDeckCount = new Map(); // format -> total decks
    const formatOracleDeckCount = new Map(); // "format|oracle_id" -> decks containing it (main only)

    for (const deck of decksInPeriod) {
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

    for (const [key, count] of formatOracleDeckCount) {
      const [format, oracleId] = key.split("|");
      const totalDecks = formatDeckCount.get(format) ?? 0;
      if (totalDecks === 0) continue;
      usageRows.push({
        format,
        oracle_id: oracleId,
        period_days: periodDays,
        usage_rate: Math.round((count / totalDecks) * 10000) / 100,
        deck_sample_size: totalDecks,
        calculated_at: today,
      });
    }
  }
  // 1回のUPSERTで送る行数が多すぎるとPostgres側のstatement timeoutに達するため分割送信する
  for (let i = 0; i < usageRows.length; i += PAGE_SIZE) {
    await supabaseUpsert(
      "card_usage_stats",
      usageRows.slice(i, i + PAGE_SIZE),
      "format,oracle_id,period_days,calculated_at",
    );
  }
  console.log(`card_usage_stats 保存: ${usageRows.length}件（${PERIOD_DAYS_OPTIONS.join("/")}日分）`);

  // 保持ポリシー: アプリはランキング表示(getCardRankingFromDb)で最新calculated_atの行しか
  // 読まず、streak計算(scripts/compute-card-streaks.mjs)だけがperiod_days=7を
  // STREAK_LOOKBACK_DAYS(60日)分さかのぼって参照する。それ以外の過去分は無期限に
  // 積み上がるだけの無駄なので、日次実行のたびに不要な古い行を削除する
  // （2026-08時点でこの間引きが無くDB容量が無料枠500MBを超過した実績があるため）。
  const USAGE_STREAK_LOOKBACK_DAYS = 60;
  const usageStreakCutoff = new Date(today);
  usageStreakCutoff.setDate(usageStreakCutoff.getDate() - USAGE_STREAK_LOOKBACK_DAYS);
  await supabaseDelete(
    `card_usage_stats?period_days=in.(30,90)&calculated_at=lt.${today}`,
  );
  await supabaseDelete(
    `card_usage_stats?period_days=eq.7&calculated_at=lt.${isoDate(usageStreakCutoff)}`,
  );

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
  for (let i = 0; i < priceRows.length; i += PAGE_SIZE) {
    await supabaseUpsert("archetype_price_stats", priceRows.slice(i, i + PAGE_SIZE), "archetype_id,calculated_at");
  }
  console.log(`archetype_price_stats 保存: ${priceRows.length}件`);

  // 保持ポリシー: dbArchetypeStats.tsは最新calculated_atの行しか読まないため、過去分は不要
  await supabaseDelete(`archetype_price_stats?calculated_at=lt.${today}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
