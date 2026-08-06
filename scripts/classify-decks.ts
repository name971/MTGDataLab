/**
 * Badaro/MTGOFormatData のルールJSONを取得し、archetypeEngine.ts（実装コードそのもの）で
 * decksテーブルの各デッキを分類してarchetype_idを更新する。
 * archetypes（db/schema.sql）にもルール一覧を投入する。
 *
 * 実行: npx tsx scripts/classify-decks.ts [format]
 * 例:   npx tsx scripts/classify-decks.ts Standard
 * （NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が環境変数に必要）
 */
import {
  classifyDeck,
  type Deck,
  type FormatData,
  type ArchetypeDefinition,
  type FallbackDefinition,
} from "../src/lib/archetypeEngine";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください");
  process.exit(1);
}

const FORMAT = process.argv[2] ?? "Standard";
const REPO_RAW = "https://raw.githubusercontent.com/Badaro/MTGOFormatData/master";

async function listDir(path: string): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/Badaro/MTGOFormatData/contents/${path}`);
  if (!res.ok) return [];
  const entries: { name: string }[] = await res.json();
  return entries.filter((e) => e.name.endsWith(".json")).map((e) => e.name);
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${REPO_RAW}/${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(`✗ ${path}: JSON解析失敗（スキップ）`);
    return null;
  }
}

async function supabaseGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// PostgRESTはデフォルトで1リクエスト最大1000行までしか返さない。orderもRangeも無いまま
// decksを取得すると、対象デッキが1000件を超えたタイミングで（順序不定の）先頭1000件しか
// 得られず、新しく取り込まれたデッキが分類対象から静かに漏れ続ける事故が実際に起きていた。
// id昇順で固定し、.range()でページングする。
const PAGE_SIZE = 1000;
async function supabaseGetAll(pathWithoutOrder: string): Promise<unknown[]> {
  const separator = pathWithoutOrder.includes("?") ? "&" : "?";
  const rows: unknown[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${pathWithoutOrder}${separator}order=id.asc`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        },
      },
    );
    if (!res.ok) throw new Error(`GET ${pathWithoutOrder} failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as unknown[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function supabaseUpsert(table: string, rows: unknown[], conflictColumn: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supabasePatch(path: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  console.log(`MTGOFormatData: ${FORMAT} のルールを取得中...`);
  const archetypeFiles = await listDir(`Formats/${FORMAT}/Archetypes`);
  const fallbackFiles = await listDir(`Formats/${FORMAT}/Fallbacks`);

  const archetypesRaw = await Promise.all(
    archetypeFiles.map((f) => fetchJson<ArchetypeDefinition>(`Formats/${FORMAT}/Archetypes/${f}`)),
  );
  const fallbacksRaw = await Promise.all(
    fallbackFiles.map((f) => fetchJson<FallbackDefinition>(`Formats/${FORMAT}/Fallbacks/${f}`)),
  );
  const archetypes = archetypesRaw.filter((a): a is ArchetypeDefinition => a !== null);
  const fallbacks = fallbacksRaw.filter((f): f is FallbackDefinition => f !== null);
  console.log(`アーキタイプ${archetypes.length}件、フォールバック${fallbacks.length}件`);

  const formatData: FormatData = { format: FORMAT, archetypes, fallbacks, fallbackMinOverlap: 3 };

  // archetypesテーブルに一覧を投入（同名重複はJSONファイル間でも起こり得るため名前でdedupe）
  const archetypeRows = archetypes.map((a) => ({
    format: FORMAT,
    name: a.Name,
    definition_source: "rule",
  }));
  const fallbackRows = fallbacks.map((f) => ({
    format: FORMAT,
    name: f.Name,
    definition_source: "fallback",
  }));
  const dedupedRows = [...new Map(
    [...archetypeRows, ...fallbackRows].map((row) => [row.name, row]),
  ).values()];
  await supabaseUpsert("archetypes", dedupedRows, "format,name");

  const savedArchetypes: { id: number; name: string }[] = await supabaseGet(
    `archetypes?format=eq.${FORMAT}&select=id,name`,
  );
  const archetypeIdByName = new Map(savedArchetypes.map((a) => [a.name, a.id]));

  // 対象フォーマットのデッキを取得して分類。oracle_id解決済みの行はcard_nameをNULLに
  // 間引いている（db/schema.sql参照）ため、card_oracles(name)を埋め込み取得してフォールバックする。
  const decks = (await supabaseGetAll(
    `decks?tournaments.format=eq.${FORMAT}&select=id,deck_cards(card_name,quantity,board,card_oracles(name)),tournaments!inner(format)`,
  )) as {
    id: number;
    deck_cards: {
      card_name: string | null;
      quantity: number;
      board: "main" | "side";
      card_oracles: { name: string } | null;
    }[];
  }[];

  let classified = 0;
  let unclassified = 0;

  for (const deckRow of decks) {
    const cardName = (c: (typeof deckRow.deck_cards)[number]) => c.card_name ?? c.card_oracles?.name ?? "";
    const deck: Deck = {
      mainboard: deckRow.deck_cards
        .filter((c) => c.board === "main")
        .map((c) => ({ name: cardName(c), count: c.quantity })),
      sideboard: deckRow.deck_cards
        .filter((c) => c.board === "side")
        .map((c) => ({ name: cardName(c), count: c.quantity })),
    };

    const result = classifyDeck(deck, formatData);
    const archetypeId = archetypeIdByName.get(result.archetype) ?? null;

    if (archetypeId) {
      await supabasePatch(`decks?id=eq.${deckRow.id}`, { archetype_id: archetypeId });
      classified++;
      console.log(`✓ deck ${deckRow.id}: ${result.archetype} (${result.matchedBy})`);
    } else {
      unclassified++;
      console.log(`- deck ${deckRow.id}: 未分類 (${result.matchedBy})`);
    }
  }

  console.log(`\n完了: ${classified}件分類、${unclassified}件未分類`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
