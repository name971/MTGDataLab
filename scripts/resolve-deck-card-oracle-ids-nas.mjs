/**
 * NASのdeck_cards（scripts/backfill-tournaments-to-nas.mjsで投入、oracle_idは全件NULL）を、
 * ローカルのScryfallバルクキャッシュ（ml/.cache/scryfall-all-cards.jsonl）でカード名から
 * 名寄せしてoracle_idを埋める。これで初めてオラクル単位の採用率・勝率集計が可能になる。
 *
 * scripts/lib/scryfallBulk.mjsのCACHE_DIRはprocess.cwd()基準のため、`cd ml`してから
 * 実行すること（ml/.cache/を見るようにするため）。
 *
 * 実行: cd ml && NAS_POSTGRES_URL=... node ../scripts/resolve-deck-card-oracle-ids-nas.mjs
 */
import pg from "pg";
import { ensureBulkData, loadIndex, findEnglishCard, resolveOracleId } from "../scripts/lib/scryfallBulk.mjs";

const NAS_POSTGRES_URL = process.env.NAS_POSTGRES_URL;
if (!NAS_POSTGRES_URL) {
  console.error("NAS_POSTGRES_URL を設定してください");
  process.exit(1);
}

async function main() {
  console.log("Scryfallバルクデータを確認中...");
  await ensureBulkData();
  console.log("インデックスを構築中...");
  const index = await loadIndex();

  // NASは同一LAN内の直接Postgres接続でEgress/WALの制約が無いため並列化はして良いが、
  // 実際に測ってみるとボトルネックは並列度ではなくディスクI/O（WALWrite/WALInsertの
  // LWLock待ちで16ワーカー全部が詰まっていた。DS220+の物理ディスクがWAL fsyncに
  // 追いつかない）だった。対策は2つ:
  // 1. 1件ずつUPDATE+コミットするのをやめ、まとめて1トランザクションでコミットする
  //    （コミットのたびに発生するWAL fsyncの回数自体を減らす）
  // 2. このセッションに限りsynchronous_commit=offにする（コミット時にディスク同期完了を
  //    待たずに返す。このNASはリビルド可能な作業用ステージングデータなので、
  //    万一のクラッシュで直近数秒のコミットが消えても実害が無い）
  const CONCURRENCY = 4;
  const BATCH_SIZE = 200;
  const pool = new pg.Pool({ connectionString: NAS_POSTGRES_URL, max: CONCURRENCY });

  const { rows: distinctNames } = await pool.query(
    "SELECT DISTINCT card_name FROM deck_cards WHERE oracle_id IS NULL AND card_name IS NOT NULL",
  );
  console.log(`未解決のカード名: ${distinctNames.length}種類（並列度${CONCURRENCY}、バッチ${BATCH_SIZE}件）`);

  let resolved = 0;
  let unresolved = 0;
  const unresolvedNames = [];
  let done = 0;

  async function resolveBatch(client, batch) {
    const toUpdate = [];
    for (const { card_name } of batch) {
      const card = findEnglishCard(index, card_name);
      const oracleId = card ? resolveOracleId(card) : null;
      if (!oracleId) {
        unresolved++;
        unresolvedNames.push(card_name);
      } else {
        toUpdate.push([oracleId, card_name]);
        resolved++;
      }
    }
    if (toUpdate.length > 0) {
      await client.query("BEGIN");
      for (const [oracleId, cardName] of toUpdate) {
        await client.query(
          "UPDATE deck_cards SET oracle_id = $1 WHERE card_name = $2 AND oracle_id IS NULL",
          [oracleId, cardName],
        );
      }
      await client.query("COMMIT");
    }
    done += batch.length;
    console.log(`  ${done}/${distinctNames.length}件処理済み...`);
  }

  const batches = [];
  for (let i = 0; i < distinctNames.length; i += BATCH_SIZE) batches.push(distinctNames.slice(i, i + BATCH_SIZE));

  let next = 0;
  async function worker() {
    const client = await pool.connect();
    try {
      await client.query("SET synchronous_commit TO off");
      while (next < batches.length) {
        await resolveBatch(client, batches[next++]);
      }
    } finally {
      client.release();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n完了: ${resolved}種類解決、${unresolved}種類未解決`);
  if (unresolvedNames.length > 0) {
    console.log("未解決の例（最大20件）:", unresolvedNames.slice(0, 20));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
