/**
 * TopDeck.gg APIから完了済みトーナメント（デッキリスト付き）を取得し、
 * tournaments / decks / deck_cards（db/schema.sql）に投入する。
 * deck_cards.oracle_idはここでは解決しない（常にNULLで入れる）。あいまい検索RPCを
 * インポート時点で毎回呼ぶと誤爆（例: "Savannah Lions"→"Savannah"）が起きやすいため、
 * 解決は scripts/import-deck-cards.mjs（バルクデータの完全一致、より安全）に一本化している。
 *
 * 差分取得: tournamentsはsource+source_event_idでupsertするため重複しないが、
 * decks/deck_cardsは常にINSERTする実装なので、同じトーナメントを再取得すると
 * デッキが二重に増える。そのため、そのトーナメントに既にdecksが1件でもあれば
 * 「取り込み済み」とみなしてdecks/deck_cardsの投入をスキップする
 * （デッキリストは大会終了後に変わらない前提）。これにより、同じ実行を毎日
 * 繰り返しても新しく増えたトーナメント分だけが差分で追加される。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... TOPDECK_API_KEY=... \
 *       node scripts/import-tournaments.mjs [format] [lastDays]
 * 例:   node scripts/import-tournaments.mjs Standard 14
 */

import { createSupabaseRest } from "./lib/supabaseRest.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TOPDECK_API_KEY = process.env.TOPDECK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TOPDECK_API_KEY) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / TOPDECK_API_KEY を設定してください",
  );
  process.exit(1);
}

const FORMAT = process.argv[2] ?? "Standard";
const LAST_DAYS = parseInt(process.argv[3] ?? "14", 10);

// TopDeck.gg側のフォーマット表記とアプリ内表記（src/lib/formats.ts）が異なるものだけ変換する
const FORMAT_ALIASES = { Commander: "EDH" };
const TOPDECK_FORMAT = FORMAT_ALIASES[FORMAT] ?? FORMAT;

const db = createSupabaseRest({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
const supabaseUpsert = (table, rows, conflictColumn) => db.upsert(table, rows, conflictColumn, { returnRows: true });
const supabaseGet = (path) => db.get(path);
const supabaseInsert = (table, rows) => db.insert(table, rows, { returnRows: true });

function computeStanding(s) {
  return `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`;
}

async function main() {
  console.log(`TopDeck.gg: ${TOPDECK_FORMAT} 直近${LAST_DAYS}日のトーナメントを取得中...`);
  const res = await fetch("https://topdeck.gg/api/v2/tournaments", {
    method: "POST",
    headers: { Authorization: TOPDECK_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      game: "Magic: The Gathering",
      format: TOPDECK_FORMAT,
      last: LAST_DAYS,
      columns: ["name", "decklist", "deckObj", "wins", "draws", "losses"],
    }),
  });
  if (!res.ok) throw new Error(`TopDeck API failed: ${res.status} ${await res.text()}`);
  const tournaments = await res.json();

  const withDecklists = tournaments.filter((t) =>
    (t.standings ?? []).some((s) => s.deckObj),
  );
  console.log(`${tournaments.length}件中 ${withDecklists.length}件にデッキリストあり`);

  let deckCount = 0;
  let cardCount = 0;
  let skippedTournaments = 0;

  for (const t of withDecklists) {
    const eventDate = new Date(t.startDate * 1000).toISOString().slice(0, 10);
    const [tournamentRow] = await supabaseUpsert(
      "tournaments",
      [
        {
          source: "topdeck",
          source_event_id: t.TID,
          format: FORMAT,
          event_name: t.tournamentName,
          event_date: eventDate,
          source_url: `https://topdeck.gg/event/${t.TID}`,
        },
      ],
      "source,source_event_id",
    );

    const existingDecks = await supabaseGet(
      `decks?tournament_id=eq.${tournamentRow.id}&select=id&limit=1`,
    );
    if (existingDecks.length > 0) {
      skippedTournaments++;
      continue;
    }

    for (const standing of t.standings ?? []) {
      if (!standing.deckObj) continue;

      const [deckRow] = await supabaseInsert("decks", [
        {
          tournament_id: tournamentRow.id,
          player_name: standing.name,
          standing: computeStanding(standing),
          archetype_id: null, // アーキタイプ判定はMTGOFormatDataのルール未整備のため未実施（reference/参照）
        },
      ]);
      deckCount++;

      const deckCardRows = [];
      for (const [boardName, cards] of Object.entries(standing.deckObj)) {
        if (boardName === "metadata") continue;
        // TopDeck.ggのEDHはdeckObjに"Commanders"キーが独立して存在する（Mainboardとは別枠）。
        // db/schema.sqlのboard CHECK制約はmain/sideのみのため、統率者はside扱いで保存し、
        // classify-decks-commander.mjsがside内の1枚をアーキタイプ名として使う。
        const boardLower = boardName.toLowerCase();
        const board = boardLower.startsWith("side") || boardLower.startsWith("commander") ? "side" : "main";
        for (const [cardName, info] of Object.entries(cards)) {
          deckCardRows.push({
            deck_id: deckRow.id,
            card_name: cardName,
            oracle_id: null, // scripts/import-deck-cards.mjs（バルクデータの完全一致）が後段で解決する
            board,
            quantity: info.count,
          });
        }
      }
      if (deckCardRows.length > 0) {
        await supabaseInsert("deck_cards", deckCardRows);
        cardCount += deckCardRows.length;
      }
      console.log(`✓ ${t.tournamentName} / ${standing.name} (${computeStanding(standing)}) - ${deckCardRows.length}種`);
    }
  }

  console.log(
    `\n完了: トーナメント${withDecklists.length}件（取り込み済みスキップ${skippedTournaments}件）、デッキ${deckCount}件、カード種類${cardCount}件`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
