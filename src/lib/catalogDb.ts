/**
 * カード図鑑カタログ（デッキで一度も使われていないカード）用D1（Cloudflare、
 * jp-mtgstocks-archive、wrangler.jsonc参照）。
 *
 * 以前はScryfallの全カードカタログ（英語・非デジタル）をSupabase Postgres（cards/
 * card_oracles/card_prints）に丸ごと取り込んでいたが、デッキで一度も使われていない
 * カードだけで4万行超あり、Supabase無料枠（500MB）を圧迫していた（実際に超過した）。
 * デッキ実績のあるカード（採用率・価格履歴等の集計対象）はPostgresに残し、
 * カタログ専用カード（名前・画像・ルールテキストだけ持てば足りる、閲覧専用）は
 * こちらのD1（無料枠5GB）に移した。
 *
 * 用途: カード詳細ページ（oracle_id直指定）・検索バーで、Postgres未収録のoracle_idや
 * カード名を引くフォールバックとしてのみ使う（advanced検索の価格/採用率/マナ総量等の
 * 絞り込みはデッキ実データ前提の機能のため対象外のまま）。
 */

export interface CatalogOracleRow {
  oracle_id: string;
  name: string;
  printed_name_ja: string | null;
  oracle_text: string | null;
}

async function getCatalogDb() {
  try {
    // 静的解析でCloudflare依存を検出されないよう動的importにする（priceArchiveDb.tsと同じ理由）
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return (env as unknown as Env).PRICE_ARCHIVE_DB ?? null;
  } catch {
    // Workersランタイム外（ローカル開発・テスト等）では取得できない。カタログはあくまで
    // 補助的なフォールバックなので、失敗時は「見つからなかった」扱いにする。
    return null;
  }
}

/** oracle_idを直接指定して1件引く（カード詳細ページのフォールバック用） */
export async function getCatalogOracleById(oracleId: string): Promise<CatalogOracleRow | null> {
  try {
    const db = await getCatalogDb();
    if (!db) return null;
    const row = await db
      .prepare("SELECT oracle_id, name, printed_name_ja, oracle_text FROM catalog_oracles WHERE oracle_id = ?1")
      .bind(oracleId)
      .first<CatalogOracleRow>();
    return row ?? null;
  } catch {
    // ローカル開発のD1レプリカにcatalog_oraclesが無い等、クエリ自体が失敗した場合も
    // カタログは補助的なフォールバックなので握りつぶして「見つからなかった」扱いにする
    return null;
  }
}

/** oracle_idの一括解決（歴代禁止カードページ等、複数まとめて引きたい場合用） */
export async function getCatalogOraclesByIds(
  oracleIds: string[],
): Promise<Map<string, CatalogOracleRow>> {
  const result = new Map<string, CatalogOracleRow>();
  if (oracleIds.length === 0) return result;
  try {
    const db = await getCatalogDb();
    if (!db) return result;

    const CHUNK = 90; // D1のバインド変数上限(100)対策
    for (let i = 0; i < oracleIds.length; i += CHUNK) {
      const chunk = oracleIds.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
      const res = await db
        .prepare(
          `SELECT oracle_id, name, printed_name_ja, oracle_text FROM catalog_oracles WHERE oracle_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<CatalogOracleRow>();
      for (const row of res.results ?? []) result.set(row.oracle_id, row);
    }
    return result;
  } catch {
    return result;
  }
}

/**
 * カード名の完全一致での一括解決（歴代禁止カードページ用）。bannedCards.tsはカード名基準の
 * データなので、Postgres側のcard_oraclesで見つからなかった名前だけこちらで引く。
 */
export async function getCatalogOraclesByNames(
  names: string[],
): Promise<Map<string, CatalogOracleRow>> {
  const result = new Map<string, CatalogOracleRow>();
  if (names.length === 0) return result;
  try {
    const db = await getCatalogDb();
    if (!db) return result;

    const CHUNK = 90;
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
      const res = await db
        .prepare(
          `SELECT oracle_id, name, printed_name_ja, oracle_text FROM catalog_oracles WHERE name IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<CatalogOracleRow>();
      for (const row of res.results ?? []) result.set(row.name, row);
    }
    return result;
  } catch {
    return result;
  }
}

export interface CatalogSearchResult {
  oracleId: string;
  nameEn: string;
  nameJa: string | null;
  imageUrl: string | null;
}

/** 検索バーのフォールバック用。カード名の英語/日本語名の部分一致で検索する。 */
export async function searchCatalogOraclesByName(query: string, limit = 10): Promise<CatalogSearchResult[]> {
  try {
    const db = await getCatalogDb();
    if (!db) return [];
    const like = `%${query}%`;
    const res = await db
      .prepare(
        "SELECT oracle_id, name, printed_name_ja, representative_image_uri FROM catalog_oracles WHERE name LIKE ?1 OR printed_name_ja LIKE ?1 LIMIT ?2",
      )
      .bind(like, limit)
      .all<{
        oracle_id: string;
        name: string;
        printed_name_ja: string | null;
        representative_image_uri: string | null;
      }>();
    return (res.results ?? []).map((r) => ({
      oracleId: r.oracle_id,
      nameEn: r.name,
      nameJa: r.printed_name_ja,
      imageUrl: r.representative_image_uri,
    }));
  } catch {
    return [];
  }
}
