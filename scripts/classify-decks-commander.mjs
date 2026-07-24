/**
 * Commanderは99枚シングルトンでMTGOFormatData（scripts/classify-decks.ts）のカード被り
 * ルールが存在しない（MTGO自体がCommanderをサポートしないため）。
 * 代わりに「統率者（deck_cards.board='side'のカード名、複数ならパートナーとして連結）」を
 * そのままアーキタイプ名として archetypes / decks.archetype_id に投入する。
 *
 * 実行: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/classify-decks-commander.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const FORMAT = "Commander";
const PAGE_SIZE = 1000;

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

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

async function supabasePatch(path, body) {
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
}

async function main() {
  console.log("Commanderデッキの統率者名を取得中...");

  const tournaments = await supabaseGet(`tournaments?format=eq.${FORMAT}&select=id`);
  const tournamentIds = new Set(tournaments.map((t) => t.id));
  if (tournamentIds.size === 0) {
    console.log("Commanderのトーナメントが見つかりません");
    return;
  }

  const decks = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await supabaseGet(
      `decks?select=id,tournament_id&order=id&offset=${offset}&limit=${PAGE_SIZE}`,
    );
    if (page.length === 0) break;
    decks.push(...page.filter((d) => tournamentIds.has(d.tournament_id)));
    if (page.length < PAGE_SIZE) break;
  }
  console.log(`対象デッキ: ${decks.length}件`);

  const deckIdToCommanderName = new Map();
  const archetypeNameToNameJa = new Map();
  const oracleIdToNameJa = new Map();

  for (let i = 0; i < decks.length; i += 50) {
    const batch = decks.slice(i, i + 50);
    const ids = batch.map((d) => d.id).join(",");
    const cards = await supabaseGet(
      `deck_cards?deck_id=in.(${ids})&board=eq.side&select=deck_id,card_name,oracle_id`,
    );
    const byDeck = new Map();
    for (const c of cards) {
      if (!byDeck.has(c.deck_id)) byDeck.set(c.deck_id, []);
      byDeck.get(c.deck_id).push(c);
    }
    for (const d of batch) {
      const commanderCards = (byDeck.get(d.id) ?? []).sort((a, b) =>
        a.card_name.localeCompare(b.card_name),
      );
      if (commanderCards.length === 0) continue;
      const archetypeName = commanderCards.map((c) => c.card_name).join(" / ");
      deckIdToCommanderName.set(d.id, archetypeName);
      if (!archetypeNameToNameJa.has(archetypeName)) {
        archetypeNameToNameJa.set(archetypeName, commanderCards.map((c) => c.oracle_id));
      }
    }
    if ((i / 50) % 10 === 0) console.log(`  ...${i + batch.length}件処理済み`);
  }

  console.log(
    `統率者判明: ${deckIdToCommanderName.size}/${decks.length}件、アーキタイプ${archetypeNameToNameJa.size}種`,
  );

  const allOracleIds = [
    ...new Set([...archetypeNameToNameJa.values()].flat().filter((id) => id !== null)),
  ];
  for (let i = 0; i < allOracleIds.length; i += 100) {
    const batch = allOracleIds.slice(i, i + 100);
    const rows = await supabaseGet(
      `card_oracles?oracle_id=in.(${batch.join(",")})&select=oracle_id,printed_name_ja`,
    );
    for (const r of rows) oracleIdToNameJa.set(r.oracle_id, r.printed_name_ja);
  }

  const archetypeRows = [...archetypeNameToNameJa.entries()].map(([name, oracleIds]) => {
    const namesJa = oracleIds.map((id) => (id ? oracleIdToNameJa.get(id) : null));
    const nameJa = namesJa.every((n) => n) ? namesJa.join(" / ") : null;
    return { format: FORMAT, name, name_ja: nameJa, definition_source: "commander" };
  });
  const upserted =
    archetypeRows.length > 0 ? await supabaseUpsert("archetypes", archetypeRows, "format,name") : [];

  const existing = await supabaseGet(
    `archetypes?format=eq.${FORMAT}&select=id,name`,
  );
  const nameToId = new Map(existing.map((a) => [a.name, a.id]));

  let updated = 0;
  for (const [deckId, name] of deckIdToCommanderName) {
    const archetypeId = nameToId.get(name);
    if (!archetypeId) continue;
    await supabasePatch(`decks?id=eq.${deckId}`, { archetype_id: archetypeId });
    updated++;
  }

  console.log(`完了: ${updated}件分類、${decks.length - updated}件未分類`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
