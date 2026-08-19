/**
 * ml/fetch_tournament_history.mjs が既に取得済みのTopDeck.ggローカルキャッシュを、
 * NAS上のPostgres（構築中の作業用、docs/incident-log.md 2026-08-17参照）へ一括投入する。
 *
 * Supabaseと違い同一LAN内の直接Postgres接続なので、Egress/WALの心配なく
 * バッチINSERTできる。1トーナメントごとにトランザクションでまとめて書き込む。
 *
 * 実行: NAS_POSTGRES_URL=... node scripts/backfill-tournaments-to-nas.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const NAS_POSTGRES_URL = process.env.NAS_POSTGRES_URL;
if (!NAS_POSTGRES_URL) {
  console.error("NAS_POSTGRES_URL を設定してください");
  process.exit(1);
}

const CACHE_DIR = path.join(import.meta.dirname, "..", "ml", "data", "topdeck_raw_cache");
const pool = new pg.Pool({ connectionString: NAS_POSTGRES_URL, max: 8 });

function computeStanding(s) {
  return `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`;
}

async function importTournament(client, t, format) {
  const eventDate = new Date(t.startDate * 1000).toISOString().slice(0, 10);

  await client.query("BEGIN");
  try {
    const { rows: [tournamentRow] } = await client.query(
      `INSERT INTO tournaments (source, source_event_id, format, event_name, event_date, source_url)
       VALUES ('topdeck', $1, $2, $3, $4, $5)
       ON CONFLICT (source, source_event_id) DO UPDATE SET format = EXCLUDED.format
       RETURNING id`,
      [t.TID, format, t.tournamentName, eventDate, `https://topdeck.gg/event/${t.TID}`],
    );

    const { rows: existing } = await client.query(
      "SELECT id FROM decks WHERE tournament_id = $1 LIMIT 1",
      [tournamentRow.id],
    );
    if (existing.length > 0) {
      await client.query("COMMIT");
      return { deckCount: 0, cardCount: 0, skipped: true };
    }

    const standingsWithDeck = (t.standings ?? []).filter((s) => s.deckObj);
    let deckCount = 0;
    let cardCount = 0;
    for (const standing of standingsWithDeck) {
      const { rows: [deckRow] } = await client.query(
        `INSERT INTO decks (tournament_id, player_name, standing, archetype_id)
         VALUES ($1, $2, $3, NULL) RETURNING id`,
        [tournamentRow.id, standing.name, computeStanding(standing)],
      );
      deckCount++;

      const cardRows = [];
      for (const [boardName, cards] of Object.entries(standing.deckObj)) {
        if (boardName === "metadata") continue;
        const boardLower = boardName.toLowerCase();
        const board = boardLower.startsWith("side") || boardLower.startsWith("commander") ? "side" : "main";
        for (const [cardName, info] of Object.entries(cards)) {
          cardRows.push([deckRow.id, cardName, board, info.count]);
        }
      }
      if (cardRows.length > 0) {
        const values = cardRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(",");
        await client.query(
          `INSERT INTO deck_cards (deck_id, card_name, board, quantity) VALUES ${values}`,
          cardRows.flat(),
        );
        cardCount += cardRows.length;
      }
    }
    await client.query("COMMIT");
    return { deckCount, cardCount, skipped: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  console.log(`${files.length}件のキャッシュファイルを処理します`);

  let totalTournaments = 0, totalDecks = 0, totalCards = 0, skipped = 0;

  for (const file of files) {
    const format = file.split("_")[0];
    const tournaments = JSON.parse(readFileSync(path.join(CACHE_DIR, file), "utf-8"));
    const withDecklists = tournaments.filter((t) => (t.standings ?? []).some((s) => s.deckObj));

    for (const t of withDecklists) {
      const client = await pool.connect();
      try {
        const { deckCount, cardCount, skipped: s } = await importTournament(client, t, format);
        if (s) skipped++;
        else {
          totalTournaments++;
          totalDecks += deckCount;
          totalCards += cardCount;
        }
      } catch (err) {
        console.error(`✗ TID=${t.TID} 失敗: ${err.message}`);
      } finally {
        client.release();
      }
    }
    console.log(`✓ ${file}（${withDecklists.length}件処理）`);
  }

  console.log(`\n完了: トーナメント${totalTournaments}件（スキップ${skipped}件）、デッキ${totalDecks}件、カード種類${totalCards}件`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
