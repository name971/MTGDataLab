/**
 * scripts/import-full-catalog.mjs のローカルPostgres版。ロジックは完全に同じで、
 * Supabase REST（PostgRESTのstatement_timeout=3秒に合わせた小バッチ）の代わりに
 * ローカルPostgresへ直接pg.Poolでバルク投入する（Supabase復旧待ちの間、
 * サイト復旧に必要なカードカタログをこのPC上で先に構築するため。
 * docs/incident-log.md 2026-08-17参照）。
 *
 * 実行: LOCAL_POSTGRES_URL=... node scripts/import-full-catalog-local.mjs
 */
import pg from "pg";
import {
  ensureBulkData,
  forEachJsonArrayObject,
  DATA_FILE,
  isBetterRepresentative,
  frontFaceName,
  frontFacePrintedName,
  combinedOracleText,
  toCardRow,
  NON_TOURNAMENT_SET_TYPES,
  resolveOracleId,
} from "./lib/scryfallBulk.mjs";

function isNotTournamentLegal(raw) {
  if (raw.set_type === "funny") return raw.security_stamp === "acorn";
  return raw.border_color === "gold" || raw.border_color === "silver" || NON_TOURNAMENT_SET_TYPES.has(raw.set_type);
}

const LOCAL_POSTGRES_URL = process.env.LOCAL_POSTGRES_URL;
if (!LOCAL_POSTGRES_URL) {
  console.error("LOCAL_POSTGRES_URL を設定してください");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: LOCAL_POSTGRES_URL, max: 4 });
const BATCH_SIZE = 1000;

async function bulkUpsert(table, rows, columns, conflictColumn) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = chunk
      .map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(",")})`)
      .join(",");
    const params = chunk.flatMap((row) => columns.map((col) => row[col] ?? null));
    const updateSet = columns.filter((c) => c !== conflictColumn).map((c) => `${c} = EXCLUDED.${c}`).join(",");
    await pool.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}
       ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateSet}`,
      params,
    );
    console.log(`  ${table}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}件...`);
  }
}

async function main() {
  await ensureBulkData();

  const bestEnByOracle = new Map();
  const jaByOracleAndPrint = new Map();
  const bestJaByOracle = new Map();
  const allPrintsByKey = new Map();
  const setsByCode = new Map();

  let scanned = 0;
  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    scanned++;
    if (raw.digital) return;
    if (raw.lang !== "en" && raw.lang !== "ja") return;
    if (raw.set_type !== "funny" && NON_TOURNAMENT_SET_TYPES.has(raw.set_type)) return;

    const resolvedOracleId = resolveOracleId(raw);
    if (!resolvedOracleId) return;

    const printKeyAll = `${resolvedOracleId}|${raw.set}|${raw.collector_number}`;
    const currentPrint = allPrintsByKey.get(printKeyAll);
    if (!(currentPrint && (currentPrint.lang === "en" || raw.lang === "ja"))) {
      allPrintsByKey.set(printKeyAll, raw);
      setsByCode.set(raw.set, raw.set_name);
    }

    if (!raw.oracle_id) return;

    if (raw.lang === "en") {
      const current = bestEnByOracle.get(raw.oracle_id);
      if (isBetterRepresentative(raw, current)) bestEnByOracle.set(raw.oracle_id, raw);
      return;
    }

    if (!jaByOracleAndPrint.has(raw.oracle_id)) jaByOracleAndPrint.set(raw.oracle_id, new Map());
    const byPrint = jaByOracleAndPrint.get(raw.oracle_id);
    const printKey = `${raw.set}#${raw.collector_number}`;
    if (isBetterRepresentative(raw, byPrint.get(printKey))) byPrint.set(printKey, raw);

    if (frontFacePrintedName(raw)) {
      const bestJa = bestJaByOracle.get(raw.oracle_id);
      if (isBetterRepresentative(raw, bestJa)) bestJaByOracle.set(raw.oracle_id, raw);
    }
  });
  console.log(`バルクデータ走査: ${scanned}件中 対象oracle_id ${bestEnByOracle.size}件`);

  const oracleRows = [];
  const cardRows = [];
  const printRows = [];

  for (const [oracleId, enCard] of bestEnByOracle) {
    const byPrint = jaByOracleAndPrint.get(oracleId);
    const printKey = `${enCard.set}#${enCard.collector_number}`;
    const jaCard = byPrint?.get(printKey) ?? null;
    const printedNameJa = jaCard
      ? frontFacePrintedName(jaCard)
      : bestJaByOracle.has(oracleId)
        ? frontFacePrintedName(bestJaByOracle.get(oracleId))
        : null;

    oracleRows.push({
      oracle_id: oracleId,
      name: frontFaceName(enCard),
      printed_name_ja: printedNameJa,
      oracle_text: combinedOracleText(enCard),
      is_reserved: enCard.reserved ?? false,
      is_serialized: enCard.promo_types?.includes("serialized") ?? false,
    });
    cardRows.push(toCardRow(enCard, oracleId));
    if (jaCard) cardRows.push(toCardRow(jaCard, oracleId));
  }

  for (const raw of allPrintsByKey.values()) {
    const oracleId = resolveOracleId(raw);
    // reversible_card等、代表プリント選定（bestEnByOracle、raw.oracle_id必須）から除外された
    // 特殊レイアウトはcard_oraclesに行が無いため、外部キー制約に引っかかる。
    // card_oraclesに実在するoracle_idの分だけを対象にする。
    if (!bestEnByOracle.has(oracleId)) continue;
    const face = raw.card_faces?.[0];
    const imageUris = raw.image_uris ?? face?.image_uris ?? null;
    printRows.push({
      scryfall_id: raw.id,
      oracle_id: oracleId,
      set_code: raw.set,
      collector_number: raw.collector_number,
      released_at: raw.released_at ?? null,
      image_uri_normal: imageUris?.normal ?? null,
      not_tournament_legal: isNotTournamentLegal(raw),
    });
  }

  const setRows = [...setsByCode.entries()].map(([set_code, set_name]) => ({ set_code, set_name }));

  // JSONB列はpgドライバが自動でJSON化しないため、渡す前に明示的に文字列化する
  for (const row of cardRows) row.legalities = JSON.stringify(row.legalities ?? {});

  console.log(
    `card_oracles: ${oracleRows.length}件、cards: ${cardRows.length}件、sets: ${setRows.length}件、card_prints: ${printRows.length}件を保存中...`,
  );
  await bulkUpsert(
    "card_oracles",
    oracleRows,
    ["oracle_id", "name", "printed_name_ja", "oracle_text", "is_reserved", "is_serialized"],
    "oracle_id",
  );
  await bulkUpsert(
    "cards",
    cardRows,
    [
      "scryfall_id", "oracle_id", "name", "printed_name_ja", "printed_text_ja", "set_code", "set_name",
      "rarity", "collector_number", "lang", "image_uri_normal", "image_uri_art_crop", "mana_cost",
      "type_line", "printed_type_line", "power", "toughness", "legalities", "released_at", "finishes",
      "is_showcase", "is_borderless", "is_promo", "is_universes_beyond",
    ],
    "scryfall_id",
  );
  await bulkUpsert("sets", setRows, ["set_code", "set_name"], "set_code");
  await bulkUpsert(
    "card_prints",
    printRows,
    ["scryfall_id", "oracle_id", "set_code", "collector_number", "released_at", "image_uri_normal", "not_tournament_legal"],
    "scryfall_id",
  );

  console.log("\n完了");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
