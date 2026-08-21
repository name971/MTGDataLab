/**
 * ml/fetch_tournament_history.mjs が既に取得済みのTopDeck.ggローカルキャッシュ
 * （ml/data/topdeck_raw_cache/<Format>_<from>_<to>.json、90日チャンク×900日分）を、
 * scripts/import-tournaments.mjs と同じロジックでSupabaseのtournaments/decks/deck_cards
 * に一括投入する一回限りのバックフィル。
 *
 * これによりSupabase側がMLが使っていた深い履歴（2.5年分）を持つようになり、
 * 以後はimport-tournaments.mjsの日次差分取得だけで維持できる
 * （ml独自のTopDeck.gg再取得・再分類は不要になる）。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *       node scripts/backfill-tournaments-from-cache.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createSupabaseRest } from "./lib/supabaseRest.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const CACHE_DIR = path.join(import.meta.dirname, "..", "ml", "data", "topdeck_raw_cache");
const db = createSupabaseRest({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });

async function supabaseUpsert(table, rows, conflictColumn) {
  return db.upsert(table, rows, conflictColumn, { returnRows: true });
}

async function supabaseGet(path) {
  return db.get(path);
}

async function supabaseInsert(table, rows, { returnRows = false } = {}) {
  return db.insert(table, rows, { returnRows });
}

function computeStanding(s) {
  return `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`;
}

async function importTournament(t, format) {
  const eventDate = new Date(t.startDate * 1000).toISOString().slice(0, 10);
  const [tournamentRow] = await supabaseUpsert(
    "tournaments",
    [
      {
        source: "topdeck",
        source_event_id: t.TID,
        format,
        event_name: t.tournamentName,
        event_date: eventDate,
        source_url: `https://topdeck.gg/event/${t.TID}`,
      },
    ],
    "source,source_event_id",
  );

  const existingDecks = await supabaseGet(`decks?tournament_id=eq.${tournamentRow.id}&select=id&limit=1`);
  if (existingDecks.length > 0) return { deckCount: 0, cardCount: 0, skipped: true };

  const standingsWithDeck = (t.standings ?? []).filter((s) => s.deckObj);
  if (standingsWithDeck.length === 0) return { deckCount: 0, cardCount: 0, skipped: false };

  // decks/deck_cardsをトーナメント単位でまとめて1リクエストずつ送る（1デッキごとに
  // 逐次リクエストしていたのが極端に遅かったため。PostgRESTのreturn=representationで
  // 返る配列は投入順を維持するので、standingsWithDeckの並びとdeckRowsの並びが対応する）
  const deckRows = await supabaseInsert(
    "decks",
    standingsWithDeck.map((standing) => ({
      tournament_id: tournamentRow.id,
      player_name: standing.name,
      standing: computeStanding(standing),
      archetype_id: null,
    })),
    { returnRows: true },
  );

  const deckCardRows = [];
  standingsWithDeck.forEach((standing, i) => {
    const deckId = deckRows[i].id;
    for (const [boardName, cards] of Object.entries(standing.deckObj)) {
      if (boardName === "metadata") continue;
      const boardLower = boardName.toLowerCase();
      const board = boardLower.startsWith("side") || boardLower.startsWith("commander") ? "side" : "main";
      for (const [cardName, info] of Object.entries(cards)) {
        deckCardRows.push({ deck_id: deckId, card_name: cardName, oracle_id: null, board, quantity: info.count });
      }
    }
  });

  // deck_cardsは1トーナメントで数千行になることがあるため、PostgRESTの1リクエスト
  // ペイロード上限を避けて500行ずつ送る
  const CHUNK = 500;
  for (let i = 0; i < deckCardRows.length; i += CHUNK) {
    await supabaseInsert("deck_cards", deckCardRows.slice(i, i + CHUNK));
  }

  return { deckCount: deckRows.length, cardCount: deckCardRows.length, skipped: false };
}

// ここまでの逐次処理が体感で遅かったため、トーナメント単位で並列実行する
// （PostgRESTへの同時接続数はSupabase無料枠でも十分余裕があるレベルの並列度に留める）
const CONCURRENCY = 4;
async function runWithConcurrency(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
  return results;
}

async function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  console.log(`${files.length}件のキャッシュファイルを処理します（並列度${CONCURRENCY}）`);

  let totalTournaments = 0;
  let totalDecks = 0;
  let totalCards = 0;
  let skippedTournaments = 0;

  for (const file of files) {
    const format = file.split("_")[0];
    const tournaments = JSON.parse(readFileSync(path.join(CACHE_DIR, file), "utf-8"));
    const withDecklists = tournaments.filter((t) => (t.standings ?? []).some((s) => s.deckObj));

    const results = await runWithConcurrency(withDecklists, async (t) => {
      try {
        return await importTournament(t, format);
      } catch (err) {
        console.error(`✗ TID=${t.TID} (${t.tournamentName}) 失敗: ${err.message}`);
        return { deckCount: 0, cardCount: 0, skipped: false, failed: true };
      }
    });
    for (const { deckCount, cardCount, skipped, failed } of results) {
      if (skipped) {
        skippedTournaments++;
      } else if (!failed) {
        totalTournaments++;
        totalDecks += deckCount;
        totalCards += cardCount;
      }
    }
    console.log(`✓ ${file}（${withDecklists.length}件処理）`);
  }

  console.log(
    `\n完了: トーナメント${totalTournaments}件（取り込み済みスキップ${skippedTournaments}件）、デッキ${totalDecks}件、カード種類${totalCards}件`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
