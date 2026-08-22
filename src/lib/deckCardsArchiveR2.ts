/**
 * 30日より前のデッキのdeck_cards（Supabaseから削除済み、scripts/archive-old-deck-cards.mjs参照）を
 * R2（deck-cards/{deckId}.ndjson.gz）から読む。priceArchiveR2.tsと同じくCloudflare WorkersのR2
 * バインディング経由（@aws-sdk/client-s3は使わない、Node.js専用のためWorkersランタイムで動かない）。
 */

const R2_DECK_CARD_PREFIX = "deck-cards";

async function getR2Bucket() {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return (env as unknown as Env).PRICE_ARCHIVE_R2 ?? null;
  } catch {
    return null;
  }
}

export interface R2ArchivedDeckCard {
  card_name: string | null;
  oracle_id: string | null;
  board: "main" | "side";
  quantity: number;
}

/** アーカイブ済みデッキのdeck_cards行一覧を取得する。未アーカイブ・存在しない場合は空配列。 */
export async function getR2ArchivedDeckCards(deckId: number): Promise<R2ArchivedDeckCard[]> {
  const bucket = await getR2Bucket();
  if (!bucket) return [];

  try {
    const obj = await bucket.get(`${R2_DECK_CARD_PREFIX}/${deckId}.ndjson.gz`);
    if (!obj) return [];
    const text = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const rows: R2ArchivedDeckCard[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
    return rows;
  } catch {
    return [];
  }
}
