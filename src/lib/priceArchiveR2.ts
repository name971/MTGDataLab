/**
 * 全カード（デッキ未使用カードを含む）の長期価格履歴（R2、カード単位NDJSON.gz、
 * ml/reshard_r2_price_history_by_card.py・scripts/lib/r2PriceArchive.mjs参照）。
 * D1（price_history_archive/print_price_history_archive）の代わりにこちらを読む
 * （D1無料枠の日次読み書き行数上限に達したため、リクエスト数課金のR2へ全面移行した）。
 *
 * 1カード＝1ファイル（oracle-history/{oracle_id}.ndjson.gz、print-history/{scryfall_id}.ndjson.gz）
 * という構造にしている。全カード横断の月次ファイル（price-history/print-price-history、
 * バッチ集計専用、各5〜8MB圧縮）を毎リクエスト全部読むと、Cloudflare Workers無料プランの
 * CPU時間制限（10ms/リクエスト）を超過する恐れがある（Parquet+hyparquetでの本番障害と同種の
 * リスク）。カード単位なら1回のGetObjectで完結し、履歴が何年分に伸びても1リクエストの
 * コストが変わらない。
 */

const R2_ORACLE_CARD_PREFIX = "oracle-history"; // (date, jpy_est, jpy_est_foil?, scryfall_id?, scryfall_id_foil?)
const R2_PRINT_CARD_PREFIX = "print-history"; // (date, usd, usd_foil?)
const R2_RECENT_CHANGES_PREFIX = "price-changes"; // 全オラクル分、1行1オラクルの単一ファイル（latest.ndjson.gz）

async function getR2Bucket() {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return (env as unknown as Env).PRICE_ARCHIVE_R2 ?? null;
  } catch {
    return null;
  }
}

async function readCardFile<T>(bucket: R2Bucket, prefix: string, cardId: string): Promise<T[]> {
  try {
    const obj = await bucket.get(`${prefix}/${cardId}.ndjson.gz`);
    if (!obj) return [];
    const text = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
    return rows;
  } catch {
    // ファイルが無い・壊れている等は「データ無し」として扱う
    return [];
  }
}

export interface R2PricePoint {
  date: string;
  usd: number;
}

type PrintCardRow = { date: string; usd: number | null; usd_foil: number | null };

/** 1プリント（scryfall_id）の全期間USD価格推移を取得する。 */
export async function getR2PrintPriceHistory(
  scryfallId: string,
  finish: "normal" | "foil" = "normal",
): Promise<R2PricePoint[]> {
  const bucket = await getR2Bucket();
  if (!bucket) return [];

  const rows = await readCardFile<PrintCardRow>(bucket, R2_PRINT_CARD_PREFIX, scryfallId);
  const column = finish === "foil" ? "usd_foil" : "usd";
  return rows
    .filter((r) => r[column] != null)
    .map((r) => ({ date: r.date, usd: Number(r[column]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 複数プリントの「直近で分かっている価格」だけを取得する（一覧表示用）。カードごとに
 * 並列でGetObjectするだけなので、対象件数が多くてもCPU消費は増えない（ネットワーク待ちは
 * CPU時間にカウントされない）。
 */
export async function getR2LatestPricesForPrints(
  scryfallIds: string[],
): Promise<Map<string, { date: string; usd: number }>> {
  const result = new Map<string, { date: string; usd: number }>();
  if (scryfallIds.length === 0) return result;

  const bucket = await getR2Bucket();
  if (!bucket) return result;

  await Promise.all(
    scryfallIds.map(async (scryfallId) => {
      const rows = await readCardFile<PrintCardRow>(bucket, R2_PRINT_CARD_PREFIX, scryfallId);
      const latest = [...rows].reverse().find((r) => r.usd != null);
      if (latest) result.set(scryfallId, { date: latest.date, usd: Number(latest.usd) });
    }),
  );
  return result;
}

export interface R2OraclePricePoint {
  date: string;
  jpy: number;
  setCode?: string;
  setName?: string;
}

type OracleCardRow = {
  date: string;
  jpy_est: number | null;
  jpy_est_foil: number | null;
  scryfall_id: string | null;
  scryfall_id_foil: string | null;
};

/**
 * 1オラクルの全期間の「全プリント中の最安値」推移を取得する（価格推移グラフ用）。
 * どのセットが最安値だったか（scryfall_id）も返すが、セット名解決は呼び出し側（Supabase）に任せる。
 */
export async function getR2ArchivedPriceHistory(
  oracleId: string,
  finish: "normal" | "foil" = "normal",
): Promise<{ date: string; price: number; scryfallId: string | null }[]> {
  const bucket = await getR2Bucket();
  if (!bucket) return [];

  const rows = await readCardFile<OracleCardRow>(bucket, R2_ORACLE_CARD_PREFIX, oracleId);
  const priceKey = finish === "foil" ? "jpy_est_foil" : "jpy_est";
  const scryfallKey = finish === "foil" ? "scryfall_id_foil" : "scryfall_id";
  return rows
    .filter((r) => r[priceKey] != null)
    .map((r) => ({ date: r.date, price: Number(r[priceKey]), scryfallId: r[scryfallKey] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 複数オラクル分・指定日以降の価格系列を一括取得する。オラクルごとに並列でGetObjectするため、
 * 対象件数が多い（数十〜百件規模）ページではラウンドトリップ数がそのまま増えて数秒〜十数秒
 * かかる。3日前比の変化率だけで足りる用途（カードランキング等）は、代わりに
 * getR2RecentPriceChanges（全オラクル分を1ファイルにまとめた事前計算済みキャッシュ、
 * GetObject1回で完結）を使うこと。こちらは個別プリントの全期間グラフ等、日別の時系列が
 * 本当に必要な場合のみ使う想定。
 */
export async function getR2RecentPriceHistoryForOracles(
  oracleIds: string[],
  sinceDate: string,
): Promise<{ oracleId: string; date: string; jpy: number }[]> {
  if (oracleIds.length === 0) return [];
  const bucket = await getR2Bucket();
  if (!bucket) return [];

  const perOracle = await Promise.all(
    oracleIds.map(async (oracleId) => {
      const rows = await readCardFile<OracleCardRow>(bucket, R2_ORACLE_CARD_PREFIX, oracleId);
      return rows
        .filter((r) => r.date >= sinceDate && r.jpy_est != null)
        .map((r) => ({ oracleId, date: r.date, jpy: Number(r.jpy_est) }));
    }),
  );
  return perOracle.flat();
}

export interface R2PriceChangeRow {
  oracleId: string;
  date: string;
  jpy: number;
  jpyFoil: number | null;
  priceChange3dPct: number | null;
  /** 直近7日分の日別価格（トレンドページの1/3/6日推移一致判定用）。古い→新しい順。 */
  recentSeries: { date: string; jpy: number }[];
}

type RecentChangeRow = {
  oracle_id: string;
  date: string;
  jpy_est: number | null;
  jpy_est_foil: number | null;
  price_change_3d_pct: number | null;
  recent_series?: { date: string; jpy: number }[];
};

/**
 * 全オラクル分の「直近価格＋3日前比の変化率」を1回のGetObjectでまとめて取得する
 * （scripts/compute-cheapest-price-snapshots.mjsが日次で書き込む事前計算済みキャッシュ）。
 * カードランキング・トレンドページなど、オラクルごとの日別時系列までは不要で
 * 3日前比の変化率だけで足りる用途向け。
 */
export async function getR2RecentPriceChanges(): Promise<Map<string, R2PriceChangeRow>> {
  const result = new Map<string, R2PriceChangeRow>();
  const bucket = await getR2Bucket();
  if (!bucket) return result;

  const rows = await readCardFile<RecentChangeRow>(bucket, R2_RECENT_CHANGES_PREFIX, "latest");
  for (const r of rows) {
    if (r.jpy_est == null) continue;
    result.set(r.oracle_id, {
      oracleId: r.oracle_id,
      date: r.date,
      jpy: Number(r.jpy_est),
      jpyFoil: r.jpy_est_foil != null ? Number(r.jpy_est_foil) : null,
      priceChange3dPct: r.price_change_3d_pct,
      recentSeries: r.recent_series ?? [],
    });
  }
  return result;
}
