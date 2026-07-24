/**
 * カード名の名寄せ（トーナメント結果のカード名表記 → card_oracles.oracle_id）
 *
 * reference/scripts/name-matching.ts から移植。元は生の `pg` Client で
 * PostgreSQLに直接クエリしていたが、本プロジェクトではSupabaseクライアント経由の
 * RPC呼び出し（db/search-design.sql の resolve_oracle_id 関数）に置き換えている。
 */
import { supabase } from "./supabase";

/** 正規化（大文字小文字・空白・アクセント記号・分割カードのスラッシュ表記を吸収） */
export function normalizeCardName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\/{1,2}\s*/g, " // ")
    .toLowerCase();
}

export interface OracleResolution {
  oracleId: string | null;
  matchType: "exact" | "fuzzy" | "unmatched";
  score?: number;
}

/**
 * カード名（表記ゆれあり）からoracle_idを解決する。
 * 完全一致 → トライグラムのあいまい一致（閾値0.6）→ 未マッチ、の3段階。
 * db/search-design.sql の resolve_oracle_id(text) 関数（要pg_trgm）を呼び出す。
 */
export async function resolveOracleId(rawName: string): Promise<OracleResolution> {
  const normalized = normalizeCardName(rawName);
  const { data, error } = await supabase.rpc("resolve_oracle_id", {
    input_name: normalized,
  });
  if (error) throw error;

  const row = data?.[0];
  if (!row) {
    return { oracleId: null, matchType: "unmatched" };
  }
  return { oracleId: row.oracle_id, matchType: row.match_type, score: row.score };
}
