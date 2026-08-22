/**
 * 古いデッキのdeck_cards（Supabase）をR2（jp-mtgstocks-price-archive、deck-cards/プレフィックス）へ
 * アーカイブするためのアクセス層。deck_cardsはトーナメント取り込みのたびに無期限に増え続け、
 * DB容量（無料枠500MB）を最も圧迫するテーブルだった（2026-08-22判明、158MB/73万行）。
 * 集計（compute-deck-stats.mjs、直近30日）・分類（classify-decks.ts、未分類デッキのみ）は
 * どちらも古いデッキのdeck_cardsを必要としないため、デッキ詳細ページ（/decks/[deckId]）表示用
 * にだけ1デッキ1ファイルでR2へ退避する（scripts/lib/r2PriceArchive.mjsのカード単位ファイルと
 * 同じ設計）。
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const R2_DECK_CARD_PREFIX = "deck-cards"; // デッキ単位、1デッキ1ファイル

let client = null;
function r2Client() {
  if (client) return client;
  client = new S3Client({
    endpoint: process.env.R2_ENDPOINT_URL,
    region: "auto",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

function bucketName() {
  const name = process.env.R2_BUCKET_NAME;
  if (!name) throw new Error("R2_BUCKET_NAME を設定してください");
  return name;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** 指定デッキのdeck_cards行一覧をR2へ書き込む（1回のみ書き込む想定、追記・マージはしない）。 */
export async function writeDeckCardsToR2(deckId, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const gz = await gzipAsync(Buffer.from(body, "utf-8"));
  await r2Client().send(
    new PutObjectCommand({ Bucket: bucketName(), Key: `${R2_DECK_CARD_PREFIX}/${deckId}.ndjson.gz`, Body: gz }),
  );
}

/** 指定デッキのdeck_cards行一覧をR2から読む。アーカイブ済みでなければ空配列。 */
export async function readDeckCardsFromR2(deckId) {
  try {
    const res = await r2Client().send(
      new GetObjectCommand({ Bucket: bucketName(), Key: `${R2_DECK_CARD_PREFIX}/${deckId}.ndjson.gz` }),
    );
    const gz = await streamToBuffer(res.Body);
    const text = (await gunzipAsync(gz)).toString("utf-8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err?.name === "NoSuchKey") return [];
    throw err;
  }
}
