/**
 * mtgo.com/decklists（Wizards of the Coast公式、robots.txtでの禁止なし）から
 * 完了済みのMTGOリーグ/チャレンジのデッキリストを取得し、tournaments / decks / deck_cards
 * （db/schema.sql）に投入する。
 *
 * TopDeck.gg（紙のトーナメント中心）ではPioneerのデータがほとんど無かったため、
 * MTGOの公式デッキリストで補う。ページには `window.MTGO.decklists.data = {...}` という
 * 形でJSONが埋め込まれているので、それを取り出してパースする。
 * deck_cards.oracle_idはここでは解決しない（常にNULL）。解決は
 * scripts/import-deck-cards.mjs（バルクデータの完全一致）に一本化している。
 *
 * 差分取得: tournamentsはsource+source_event_idでupsertするため重複しないが、
 * decks/deck_cardsは常にINSERTする実装なので、同じイベントを再取得するとデッキが
 * 二重に増える。そのため、そのトーナメントに既にdecksが1件でもあれば
 * 「取り込み済み」とみなしてスキップする（デッキリストは公開後変わらない前提）。
 * これにより、同じ実行を毎日繰り返しても新しく公開されたイベント分だけが差分で追加される。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *       node scripts/import-mtgo-decklists.mjs [mtgoSlugPrefix] [format]
 * 例:   node scripts/import-mtgo-decklists.mjs pioneer Pioneer
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const SLUG_PREFIX = process.argv[2] ?? "pioneer";
const FORMAT = process.argv[3] ?? "Pioneer";

// Connection: keep-aliveのまま同じTCP接続を使い回すと、mtgo.com側が時々セッション確立目的の
// 302を返して失敗することが実際に確認された（間隔を空けても再現し、Connection: closeで
// 都度新規接続にしたら解消した）。接続を使い回さないよう明示的に指定する。
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; jp-mtgstocks/0.1)",
  Connection: "close",
};

async function supabaseUpsert(table, rows, conflictColumn) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabaseInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} insert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** 文字列カウント方式で"key": の直後にある{...}をJSとして安全に切り出す（末尾に続くJSコードは無視する） */
function extractJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === "\\") escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 64件前後のページを連続で叩くと、mtgo.com側が時々セッション確立目的の302を返して失敗することが
// ある（実際にGitHub Actionsで頻発した）。1秒未満の間隔での即時リトライは検証の結果ほぼ無意味
// だったため（同じ理由で再度失敗するだけ）、ここでは1回だけ試す。失敗分の再挑戦は
// fetchAllWithRetry側で数秒空けてバッチ単位にまとめて行う。
const FETCH_INTERVAL_MS = 400;

async function fetchDecklistData(path) {
  try {
    // 接続タイムアウト等のネットワーク例外もここで拾う。素通しすると1件の失敗で
    // main()全体がクラッシュし、GitHub Actions側はcontinue-on-error:trueで
    // ジョブが「success」表示になるため、残りのイベントが丸ごと未処理のまま
    // 誰にも気づかれず消える事故が実際に起きた。
    const res = await fetch(`https://www.mtgo.com${path}`, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const marker = "window.MTGO.decklists.data = ";
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) return null;
    const jsonText = extractJsonObject(html, markerIdx + marker.length);
    if (!jsonText) return null;
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function computeStanding(wins) {
  if (!wins) return "?-?";
  const draws = wins.draws && wins.draws !== "0" ? `-${wins.draws}` : "";
  return `${wins.wins}-${wins.losses}${draws}`;
}

/**
 * リーグイベント（name/publish_date、各decklistにwins/losses直付け）と
 * チャレンジイベント（description/starttime、standings配列を別途login_nameで突き合わせ）で
 * JSON構造が異なるため、共通の形に正規化する。
 */
function normalizeEventData(data) {
  const eventName = data.name ?? data.description ?? null;
  const eventDate = data.publish_date ?? (data.starttime ? data.starttime.slice(0, 10) : null);
  if (!eventName || !eventDate) return null;

  const standingByPlayer = new Map((data.standings ?? []).map((s) => [s.login_name, s]));

  const decks = data.decklists.map((d) => {
    const standing = d.wins
      ? computeStanding(d.wins)
      : standingByPlayer.has(d.player)
        ? `Rank ${standingByPlayer.get(d.player).rank}`
        : "?-?";
    return { player: d.player, standing, main_deck: d.main_deck, sideboard_deck: d.sideboard_deck };
  });

  return { eventName, eventDate, decks };
}

// /decklistsの一覧ページには直近の一定件数しか載らないため、この実行で取得に失敗したイベントは
// 数日後には一覧から押し出されて二度と拾えなくなる（実際に日次実行を続けるうちに取りこぼしが
// 蓄積していった）。翌日の再実行に賭けるのではなく、この実行の中で失敗分だけを対象に
// 間隔を空けて複数回リトライし、その場で拾い切る。
const BATCH_RETRY_PASSES = 4;
const BATCH_RETRY_DELAY_MS = 5000;

async function fetchAllWithRetry(paths) {
  const results = new Map();
  let remaining = paths;
  for (let pass = 1; pass <= BATCH_RETRY_PASSES && remaining.length > 0; pass++) {
    if (pass > 1) {
      console.log(`  ...${remaining.length}件を再挑戦（${pass}回目）`);
      await sleep(BATCH_RETRY_DELAY_MS);
    }
    const stillFailed = [];
    for (let i = 0; i < remaining.length; i++) {
      if (i > 0) await sleep(FETCH_INTERVAL_MS);
      const rawData = await fetchDecklistData(remaining[i]);
      if (rawData) results.set(remaining[i], rawData);
      else stillFailed.push(remaining[i]);
    }
    remaining = stillFailed;
  }
  return results;
}

async function main() {
  console.log(`mtgo.com/decklists: ${SLUG_PREFIX}系の完了済みイベントを取得中...`);
  const indexRes = await fetch("https://www.mtgo.com/decklists", { headers: FETCH_HEADERS });
  if (!indexRes.ok) throw new Error(`decklists一覧の取得に失敗: ${indexRes.status}`);
  const indexHtml = await indexRes.text();

  const linkPattern = new RegExp(`href="(/decklist/${SLUG_PREFIX}[^"]*)"`, "g");
  const paths = [...new Set([...indexHtml.matchAll(linkPattern)].map((m) => m[1]))];
  console.log(`対象イベント: ${paths.length}件`);

  const dataByPath = await fetchAllWithRetry(paths);

  let tournamentCount = 0;
  let deckCount = 0;
  let cardCount = 0;
  let skippedTournaments = 0;

  for (const path of paths) {
    const rawData = dataByPath.get(path);
    if (!rawData || !rawData.decklists?.length) {
      console.error(`✗ ${path}: データ取得できず（${BATCH_RETRY_PASSES}回リトライ後も失敗）`);
      continue;
    }
    const data = normalizeEventData(rawData);
    if (!data) {
      console.error(`✗ ${path}: イベント名/日付が取得できず`);
      continue;
    }

    const [tournamentRow] = await supabaseUpsert(
      "tournaments",
      [
        {
          source: "mtgo",
          // rawData.site_nameは信用しない: 同じイベントを再取得すると、mtgo.com側が
          // 時々日付の異なる壊れた値（例: "standard-league-2019-09-12..."）を返すことが
          // 実際に確認された（重複トーナメント発生の実例）。一覧ページのURLパス自体は
          // 安定しているため、こちらをキーにする。
          source_event_id: path.replace(/^\/decklist\//, ""),
          format: FORMAT,
          event_name: data.eventName,
          event_date: data.eventDate,
          source_url: `https://www.mtgo.com${path}`,
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
    tournamentCount++;

    for (const standing of data.decks) {
      const [deckRow] = await supabaseInsert("decks", [
        {
          tournament_id: tournamentRow.id,
          player_name: standing.player,
          standing: standing.standing,
          archetype_id: null,
        },
      ]);
      deckCount++;

      // mtgo.comのJSONは同じカードが（おそらく所持している別セット/Foilの実体ごとに）
      // 複数のエントリーに分かれていることがある（例: Islandが1枚ずつ3エントリー）。
      // card_name単位で合算してから1行にする（キーにカード名をそのまま連結すると
      // スペース入りの名前で誤爆するため、board別のMapをネストして安全に集計する）。
      function addQuantities(entries, board, byBoard) {
        const byCardName = byBoard.get(board) ?? new Map();
        for (const card of entries ?? []) {
          const name = card.card_attributes.card_name;
          byCardName.set(name, (byCardName.get(name) ?? 0) + parseInt(card.qty, 10));
        }
        byBoard.set(board, byCardName);
      }
      const quantityByBoard = new Map();
      addQuantities(standing.main_deck, "main", quantityByBoard);
      addQuantities(standing.sideboard_deck, "side", quantityByBoard);

      const deckCardRows = [];
      for (const [board, byCardName] of quantityByBoard) {
        for (const [cardName, quantity] of byCardName) {
          deckCardRows.push({ deck_id: deckRow.id, card_name: cardName, oracle_id: null, board, quantity });
        }
      }
      if (deckCardRows.length > 0) {
        await supabaseInsert("deck_cards", deckCardRows);
        cardCount += deckCardRows.length;
      }
      console.log(`✓ ${data.eventName} / ${standing.player} (${standing.standing}) - ${deckCardRows.length}種`);
    }
  }

  console.log(
    `\n完了: イベント${tournamentCount}件（取り込み済みスキップ${skippedTournaments}件）、デッキ${deckCount}件、カード種類${cardCount}件`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
