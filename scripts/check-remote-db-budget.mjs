/**
 * リモートPostgres（Supabase等）へ一括投入する前に、投入予定データの容量と
 * リモート側の現在の容量を突き合わせて、無料枠（デフォルト450MB、Supabase 500MB制限に
 * 安全マージンを見た値）を超えないか事前にチェックする。
 *
 * 2026-08-20、新規作成したばかりのSupabaseプロジェクトへ2.5年分のtournaments/decks/
 * deck_cardsを容量を全く見積もらずに一括投入し、即座に500MB上限を超えて読み取り専用に
 * ロックされるインシデントが発生した（docs/incident-log.md参照）。数時間前に「大量書き込み前に
 * 容量を確認する」教訓を得ていたにもかかわらず、新しいコンテキスト（ローカル→リモート投入）では
 * 同じチェックを怠った。「教訓をメモに書く」だけでは再発を防げないことが複数回実証されているため、
 * 今回は実際にこのチェックをコードとして独立させ、一括投入スクリプトから呼び出せるようにする。
 *
 * 実行: node scripts/check-remote-db-budget.mjs \
 *   --local "postgresql://..." --remote "postgresql://..." \
 *   --tables card_oracles,cards,sets,card_prints,tournaments,decks,deck_cards \
 *   [--budget-mb 450]
 */
import pg from "pg";

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const localUrl = args.local;
  const remoteUrl = args.remote;
  const tables = (args.tables ?? "").split(",").filter(Boolean);
  const budgetMb = Number(args["budget-mb"] ?? 450);

  if (!localUrl || !remoteUrl || tables.length === 0) {
    console.error("使い方: --local <接続文字列> --remote <接続文字列> --tables <table1,table2,...> [--budget-mb 450]");
    process.exit(1);
  }

  const localPool = new pg.Pool({ connectionString: localUrl, max: 1 });
  const remotePool = new pg.Pool({ connectionString: remoteUrl, max: 1 });

  const { rows: localSizes } = await localPool.query(
    `SELECT relname, pg_total_relation_size(relid) AS bytes
     FROM pg_catalog.pg_statio_user_tables WHERE relname = ANY($1)`,
    [tables],
  );
  const localTotalBytes = localSizes.reduce((sum, r) => sum + Number(r.bytes), 0);

  const { rows: remoteSizeRows } = await remotePool.query(
    "SELECT pg_database_size(current_database()) AS bytes",
  );
  const remoteCurrentBytes = Number(remoteSizeRows[0].bytes);

  const localMb = localTotalBytes / 1024 / 1024;
  const remoteMb = remoteCurrentBytes / 1024 / 1024;
  const projectedMb = remoteMb + localMb;

  console.log(`投入予定データ（ローカル ${tables.length}テーブル合計）: ${localMb.toFixed(1)}MB`);
  console.log(`リモート現在のDBサイズ: ${remoteMb.toFixed(1)}MB`);
  console.log(`投入後の予測サイズ: ${projectedMb.toFixed(1)}MB（予算: ${budgetMb}MB）`);

  await localPool.end();
  await remotePool.end();

  if (projectedMb > budgetMb) {
    console.error(
      `\n✗ 予算超過: ${(projectedMb - budgetMb).toFixed(1)}MB オーバーします。投入する前にテーブル・期間を絞ってください。`,
    );
    process.exit(1);
  }
  console.log("\n✓ 予算内です。投入して問題ありません。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
