/**
 * 2日より前のトーナメントのdeck_cardsをR2（deck-cards/{deckId}.ndjson.gz）へアーカイブし、
 * Supabaseから削除する。deck_cardsはトーナメント取り込みのたびに無期限に増え続け、
 * DB容量（無料枠500MB）を最も圧迫するテーブルだった（2026-08-22判明、158MB/73万行、
 * 2026-09-16判明・242MB/91万行）。
 *
 * 2026-09-16、それまでの30日保持（集計compute-deck-stats.mjsのPERIOD_DAYS_OPTIONS=[7,30]に
 * 合わせていた）から2日へ大幅短縮した。集計（compute-deck-stats.mjs）・分類
 * （classify-decks.ts/classify-decks-commander.mjs）は元々GitHub Actions上の日次バッチで
 * 実行時間の制約が緩く、ユーザーの待ち時間に影響しないため、Supabaseに無いデッキ分は
 * それぞれR2から1デッキ単位で読み直すフォールバックを追加した（各スクリプト参照）。
 * デッキ詳細ページ（/decks/[deckId]）は元々src/lib/dbDeckDetail.tsがR2へフォールバックして
 * 表示を続ける設計だったため変更不要。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *      R2_BUCKET_NAME=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_ENDPOINT_URL=... \
 *      node scripts/archive-old-deck-cards.mjs
 */

import { writeDeckCardsToR2 } from "./lib/r2DeckArchive.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const ARCHIVE_OLDER_THAN_DAYS = 2;
// decks/tournaments自体はdeck_cardsと違って軽い（14,043件で2.68MB）ため、こちらは従来通り
// 30日保持する。デッキランキング（getArchetypesFromDb、7/30/90日タブ）・デッキ一覧の
// 「実際のトーナメント戦績デッキ」表示がdecksテーブルの存在に依存しているため、deck_cards
// と同じ2日で消すとこれらのページから古いデッキが消えてしまう（2026-09-16、この短縮作業中に
// 発覚・回避）。
const DECKS_DELETE_OLDER_THAN_DAYS = 30;
// DB容量逼迫（500MB無料枠の95%）で200件単位のSELECTすらstatement timeoutした実績があるため、
// 一時的に50件へ縮小（2026-08-27）。負荷が落ち着いたら200に戻して良い。
const DECK_ID_CHUNK = 50;

async function supabaseGetAll(pathWithoutOrder) {
  const PAGE_SIZE = 1000;
  const separator = pathWithoutOrder.includes("?") ? "&" : "?";
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithoutOrder}${separator}order=id.asc`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`GET ${pathWithoutOrder} failed: ${res.status} ${await res.text()}`);
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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_OLDER_THAN_DAYS);
  const cutoffStr = isoDate(cutoff);

  console.log(`${cutoffStr}より前のデッキを対象にアーカイブ...`);
  const deckMetas = await supabaseGetAll(
    `decks?tournaments.event_date=lt.${cutoffStr}&select=id,tournaments!inner(event_date)`,
  );
  console.log(`対象デッキ: ${deckMetas.length}件（既にアーカイブ済みの分も含む）`);

  let archivedDecks = 0;
  let deletedRows = 0;

  for (let i = 0; i < deckMetas.length; i += DECK_ID_CHUNK) {
    const idsChunk = deckMetas.slice(i, i + DECK_ID_CHUNK).map((d) => d.id);
    // PostgRESTはRange無しだとデフォルト1000行で暗黙に切り捨てる。200デッキ分の
    // deck_cardsは（Commanderは1デッキ100枚のため）1000行を軽く超えうるので、
    // supabaseGet（無ページング）ではなく必ずsupabaseGetAll（Rangeページング）を使う。
    const cards = await supabaseGetAll(
      `deck_cards?select=deck_id,card_name,oracle_id,board,quantity&deck_id=in.(${idsChunk.join(",")})`,
    );
    if (cards.length === 0) continue; // このチャンクは既に全部アーカイブ済み

    const byDeckId = new Map();
    for (const c of cards) {
      if (!byDeckId.has(c.deck_id)) byDeckId.set(c.deck_id, []);
      byDeckId.get(c.deck_id).push({ card_name: c.card_name, oracle_id: c.oracle_id, board: c.board, quantity: c.quantity });
    }

    for (const [deckId, rows] of byDeckId) {
      await writeDeckCardsToR2(deckId, rows);
      archivedDecks++;
    }

    await supabaseDelete(`deck_cards?deck_id=in.(${[...byDeckId.keys()].join(",")})`);
    deletedRows += cards.length;
    console.log(`  ${i + idsChunk.length}/${deckMetas.length}件処理済み（累計${archivedDecks}デッキ、${deletedRows}行削除）`);
  }

  console.log(`完了: ${archivedDecks}デッキをR2へアーカイブ、${deletedRows}行をSupabaseから削除`);

  // decks/tournaments自体はdeck_cardsより長く（DECKS_DELETE_OLDER_THAN_DAYS）保持する
  // （上のコメント参照）。
  const decksCutoff = new Date();
  decksCutoff.setDate(decksCutoff.getDate() - DECKS_DELETE_OLDER_THAN_DAYS);
  const decksCutoffStr = isoDate(decksCutoff);

  const oldDeckMetas = await supabaseGetAll(
    `decks?tournaments.event_date=lt.${decksCutoffStr}&select=id,tournaments!inner(event_date)`,
  );
  const deckIds = oldDeckMetas.map((d) => d.id);
  let deletedDecks = 0;
  for (let i = 0; i < deckIds.length; i += DECK_ID_CHUNK) {
    const idsChunk = deckIds.slice(i, i + DECK_ID_CHUNK);
    await supabaseDelete(`decks?id=in.(${idsChunk.join(",")})`);
    deletedDecks += idsChunk.length;
  }
  console.log(`decks削除: ${deletedDecks}件（${decksCutoffStr}より前）`);

  const oldTournaments = await supabaseGetAll(`tournaments?select=id&event_date=lt.${decksCutoffStr}`);
  if (oldTournaments.length > 0) {
    const tIds = oldTournaments.map((t) => t.id);
    for (let i = 0; i < tIds.length; i += DECK_ID_CHUNK) {
      const idsChunk = tIds.slice(i, i + DECK_ID_CHUNK);
      await supabaseDelete(`tournaments?id=in.(${idsChunk.join(",")})`);
    }
  }
  console.log(`tournaments削除: ${oldTournaments.length}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
