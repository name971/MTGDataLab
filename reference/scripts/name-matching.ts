import { Client } from "pg";

function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\/{1,2}\s*/g, " // ")
    .toLowerCase();
}

async function resolveOracleId(client: Client, rawName: string): Promise<{
  oracleId: string | null;
  matchType: "exact" | "fuzzy" | "unmatched";
  score?: number;
}> {
  const normalized = normalize(rawName);

  // 1. 完全一致を試す（正規化済みの名前同士で比較）
  const exact = await client.query(
    `SELECT oracle_id FROM card_oracles WHERE lower(trim(name)) = $1 LIMIT 1`,
    [normalized]
  );
  if (exact.rows.length > 0) {
    return { oracleId: exact.rows[0].oracle_id, matchType: "exact" };
  }

  // 2. 完全一致で見つからなければ、トライグラムのあいまい一致にフォールバック
  //    閾値を高め(0.6)に設定し、誤マッチを避ける
  const fuzzy = await client.query(
    `SELECT oracle_id, name, similarity(lower(name), $1) AS score
     FROM card_oracles
     WHERE similarity(lower(name), $1) > 0.6
     ORDER BY score DESC LIMIT 1`,
    [normalized]
  );
  if (fuzzy.rows.length > 0) {
    return {
      oracleId: fuzzy.rows[0].oracle_id,
      matchType: "fuzzy",
      score: fuzzy.rows[0].score,
    };
  }

  // 3. どちらでも見つからなければ未マッチ（後で人力レビューに回す）
  return { oracleId: null, matchType: "unmatched" };
}

async function main() {
  const client = new Client({
    host: "127.0.0.1",
    port: 5432,
    database: "testdb",
    user: "postgres",
    password: "postgres",
  });
  await client.connect();

  const testInputs = [
    "Ragavan, Nimble Pilferer",   // 完全一致するはず
    "ragavan,  nimble pilferer",  // 表記ゆれだが正規化後は完全一致するはず
    "Ragavvan, Nimble Pilferer",  // タイポ → あいまい一致で拾えるはず
    "Some Totally Fake Card",     // どのカードにも該当しない → 未マッチのはず
  ];

  for (const input of testInputs) {
    const result = await resolveOracleId(client, input);
    console.log(`"${input}"`.padEnd(32), "→", result);
  }

  await client.end();
}

main();
