/**
 * Scryfallのbulk data（https://scryfall.com/docs/api/bulk-data）をダウンロード・キャッシュし、
 * カード名/scryfall_id/oracle_idからのローカル検索を提供する共通モジュール。
 *
 * 1枚ずつAPIを叩く方式（旧snapshot-prices.mjs / import-*-cards.mjs）はScryfallのレート制限に
 * 頻繁に引っかかっていたため、日次で1回だけdefault_cards（全プリント）をまとめて取得し、
 * それ以降はローカルのインデックスから引く方式に切り替える。
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".cache");
// default_cardsは英語版が存在するカードの日本語プリントを含まないため、全言語を含むall_cardsを使う。
// ダウンロードサイズは大きくなるが、読み込み時にen/ja以外は保持せず破棄するのでメモリは膨らまない。
export const DATA_FILE = path.join(CACHE_DIR, "scryfall-all-cards.json");
const META_FILE = path.join(CACHE_DIR, "scryfall-all-cards.meta.json");

const SCRYFALL_HEADERS = {
  "User-Agent": "jp-mtgstocks/0.1 (+https://github.com/jp-mtgstocks)",
  Accept: "application/json",
};

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

/** 句読点の揺れ（アポストロフィ有無、カンマ等）を吸収した緩い正規化 */
function looseNormalizeName(name) {
  return normalizeName(name).replace(/[^a-z0-9]/g, "");
}

async function fetchBulkDataMeta() {
  const res = await fetch("https://api.scryfall.com/bulk-data", { headers: SCRYFALL_HEADERS });
  if (!res.ok) throw new Error(`bulk-data一覧の取得に失敗: ${res.status}`);
  const data = await res.json();
  const entry = data.data.find((d) => d.type === "all_cards");
  if (!entry) throw new Error("all_cardsのbulk-dataエントリが見つかりません");
  return entry;
}

/**
 * キャッシュが無い、またはScryfall側で更新されている場合のみ再ダウンロードする。
 * forceRefresh=trueで無条件に再ダウンロード。
 */
export async function ensureBulkData({ forceRefresh = false } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });

  const remoteMeta = await fetchBulkDataMeta();

  let cachedMeta = null;
  try {
    cachedMeta = JSON.parse(await readFile(META_FILE, "utf8"));
  } catch {
    // キャッシュ無し
  }

  const cacheExists = await stat(DATA_FILE).then(
    () => true,
    () => false,
  );

  if (!forceRefresh && cacheExists && cachedMeta?.updated_at === remoteMeta.updated_at) {
    console.log(`Scryfallバルクデータ: キャッシュ済み（更新日時 ${remoteMeta.updated_at}）`);
    return;
  }

  console.log(
    `Scryfallバルクデータをダウンロード中... (${(remoteMeta.size / 1024 / 1024).toFixed(0)}MB, 更新日時 ${remoteMeta.updated_at})`,
  );
  const res = await fetch(remoteMeta.download_uri, { headers: SCRYFALL_HEADERS });
  if (!res.ok) throw new Error(`バルクデータのダウンロードに失敗: ${res.status}`);
  // ファイルが500MB超でNodeの文字列長上限（約536MB）に達するため、
  // res.text()で丸ごと文字列化せずストリームのままディスクへ書き出す
  await pipeline(Readable.fromWeb(res.body), createWriteStream(DATA_FILE));
  await writeFile(META_FILE, JSON.stringify({ updated_at: remoteMeta.updated_at }));
  console.log("Scryfallバルクデータのダウンロード完了");
}

/**
 * ファイル全体をトップレベルのJSON配列とみなし、要素（オブジェクト）が1件確定するたびに
 * onObjectを同期的に呼び出す軽量ストリーミングパーサー。
 *
 * 外部ライブラリ（stream-json）をNode.js 22/24 + このバルクデータ規模（2GB超）で使うと、
 * .pipe()を跨いだバックプレッシャーが効かず消費が追いつく前にオブジェクトが溜まり続けて
 * ヒープが枯渇する現象が再現したため、依存を持たない最小限の実装に置き換えている。
 * バッファは「現在パース中の未完了オブジェクトの残り」しか保持しないため、
 * ファイルサイズに関わらずメモリ使用量は一定に保たれる。
 */
export async function forEachJsonArrayObject(filePath, onObject) {
  const decoder = new StringDecoder("utf8");

  // buffer は「まだ処理していない残り」だけを保持する。オブジェクトが1件完成するたびに
  // 消費済み部分を切り捨てるので、ファイルサイズに関わらずbufferは小さいまま保たれる。
  let buffer = "";
  let pos = 0;
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escapeNext = false;

  function consumeAvailable() {
    while (pos < buffer.length) {
      const ch = buffer[pos];

      if (objectStart === -1) {
        // トップレベルのオブジェクト開始待ち（配列の[やカンマ、空白は読み飛ばす）
        if (ch === "{") {
          objectStart = pos;
          depth = 1;
          inString = false;
          escapeNext = false;
        }
        pos++;
        continue;
      }

      if (inString) {
        if (escapeNext) escapeNext = false;
        else if (ch === "\\") escapeNext = true;
        else if (ch === '"') inString = false;
        pos++;
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          onObject(JSON.parse(buffer.slice(objectStart, pos + 1)));
          objectStart = -1;
        }
      }
      pos++;
    }

    // 消費済みの先頭部分を切り捨ててバッファを小さく保つ
    const keepFrom = objectStart === -1 ? pos : objectStart;
    buffer = buffer.slice(keepFrom);
    pos -= keepFrom;
    if (objectStart !== -1) objectStart -= keepFrom;
  }

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      consumeAvailable();
    });
    stream.on("end", () => {
      buffer += decoder.end();
      consumeAvailable();
      resolve();
    });
    stream.on("error", reject);
  });
}

function slimFace(face) {
  if (!face) return undefined;
  return {
    name: face.name,
    printed_name: face.printed_name,
    mana_cost: face.mana_cost,
    type_line: face.type_line,
    oracle_text: face.oracle_text,
    printed_text: face.printed_text,
    image_uris: face.image_uris
      ? { normal: face.image_uris.normal, art_crop: face.image_uris.art_crop }
      : undefined,
  };
}

/**
 * Scryfallの生カードオブジェクトはoracle_text・flavor_text・all_parts・foreign関連URL等
 * 大きなフィールドを大量に持っており、all_cards（全言語）を丸ごと保持するとヒープが
 * すぐに枯渇する。ここでアプリが実際に使うフィールドだけに絞り込んでからインデックスに積む。
 */
function slimCard(card) {
  return {
    id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    lang: card.lang,
    printed_name: card.printed_name,
    printed_type_line: card.printed_type_line,
    set: card.set,
    set_name: card.set_name,
    set_type: card.set_type,
    rarity: card.rarity,
    collector_number: card.collector_number,
    mana_cost: card.mana_cost,
    type_line: card.type_line,
    oracle_text: card.oracle_text,
    printed_text: card.printed_text,
    legalities: card.legalities,
    released_at: card.released_at,
    finishes: card.finishes,
    promo: card.promo,
    digital: card.digital,
    border_color: card.border_color,
    is_showcase: card.frame_effects?.includes("showcase") ?? false,
    image_uris: card.image_uris
      ? { normal: card.image_uris.normal, art_crop: card.image_uris.art_crop }
      : undefined,
    card_faces: card.card_faces?.length ? card.card_faces.map(slimFace) : undefined,
    prices: card.prices ? { usd: card.prices.usd, eur: card.prices.eur } : undefined,
  };
}

let indexCache = null;

// トーナメントで使用できない特殊プロダクト（記念グッズ・トークン・アートカード・Un-set等）。
// 例: 30th Anniversary Edition（set_type=memorabilia）は紙のカードとして売られているが、
// 公式に対戦での使用が認められていないため代表プリントとして選ぶべきではない。
export const NON_TOURNAMENT_SET_TYPES = new Set(["memorabilia", "token", "art_series", "funny", "minigame"]);

/**
 * 代表プリント選定基準:
 * 1. 「非promo・非デジタル・トーナメント対応セット」を優先（紙のカードとして買え、実際に
 *    対戦で使える方が価格の意味がある）
 * 2. 同条件ならUSD価格が付いている方を優先（同じセット・同じ日付で複数バリアントがあり、
 *    片方だけ値付けされていないケースがある。例: Underground Sea 30aの通常版/特殊版）
 * 3. それでも同条件なら一番安いプリントを優先（ユーザーが実際に買い揃えるコストの目安に
 *    近いのは「最新リリース」より「最安値」のため）
 */
export function isBetterRepresentative(candidate, current) {
  if (!current) return true;
  const candidatePreferred = !candidate.promo && !candidate.digital && !NON_TOURNAMENT_SET_TYPES.has(candidate.set_type);
  const currentPreferred = !current.promo && !current.digital && !NON_TOURNAMENT_SET_TYPES.has(current.set_type);
  if (candidatePreferred !== currentPreferred) return candidatePreferred;

  const candidateHasPrice = candidate.prices?.usd != null;
  const currentHasPrice = current.prices?.usd != null;
  if (candidateHasPrice !== currentHasPrice) return candidateHasPrice;

  if (candidateHasPrice && currentHasPrice) {
    return parseFloat(candidate.prices.usd) < parseFloat(current.prices.usd);
  }

  return (candidate.released_at ?? "") > (current.released_at ?? "");
}

/**
 * ensureBulkData()実行後に呼ぶこと。インデックスをメモリ上に構築する（一度だけ）。
 * ファイルが500MB超でNodeの文字列長上限に達するため、forEachJsonArrayObject()で1件ずつ
 * ストリーミングパースする（readFile(...,"utf8") + JSON.parse()は使えない）。
 *
 * all_cardsは全言語×全プリントで数十万件あり、プリントを配列で全件保持すると
 * ヒープが枯渇する。そのため各キー（scryfall_id自体は別として、カード名・oracle_id）に
 * つき「今のところ一番良い1件」だけをその場で置き換えながら保持し、配列を作らない。
 */
export async function loadIndex() {
  if (indexCache) return indexCache;

  // 価格はscryfall_id単位でピンポイント参照するだけなので、必要最小限のフィールドのみ保持する
  const priceById = new Map();
  const byExactNameEn = new Map();
  const byLooseNameEn = new Map();
  const byOracleIdJa = new Map();
  // 名前ごとに「表面名の完全一致（tier 0）」か「裏面名・別名のみの一致（tier 1）」かを記録する。
  // 例: "Ancestral Recall"は本物の単面カードだが、"Emeritus of Ideation // Ancestral Recall"
  // という無関係な両面カードの裏面名としても存在する。裏面名は表面名と同じ扱いで拾わないと
  // 両面カードが名前だけで引けなくなる（コメント参照）一方、tierを区別せずisBetterRepresentative
  // （価格・発売日）だけで競わせると、無関係な両面カードの裏面名が本物の単面カードを
  // 上書きしてしまう事故が起きる（実際にAncestral Recallで発生した）。
  const exactNameTier = new Map();
  const looseNameTier = new Map();

  await forEachJsonArrayObject(DATA_FILE, (raw) => {
    // all_cardsは全言語を含むため、アプリで使わない言語は保持せずその場で捨ててメモリを抑える
    if (raw.lang !== "en" && raw.lang !== "ja") return;

    priceById.set(raw.id, {
      oracle_id: raw.oracle_id,
      lang: raw.lang,
      usd: raw.prices?.usd ?? null,
      eur: raw.prices?.eur ?? null,
      set_type: raw.set_type,
    });

    if (raw.lang === "ja" && raw.oracle_id) {
      // 英語版と同じプリント（セット＋コレクター番号）の日本語版を掲載したいのでキーはその組み合わせ。
      // 同じセット内でも通常版/ショーケース版等でコレクター番号・アートが異なることがあるため、
      // セットコードだけで一致させると別バージョンの絵柄が混ざってしまう
      // （例: Murders at Karlov Manor Underground Mortuary #271と#333は同じmkmセットだが別アート）。
      if (!byOracleIdJa.has(raw.oracle_id)) byOracleIdJa.set(raw.oracle_id, new Map());
      const byPrint = byOracleIdJa.get(raw.oracle_id);
      const printKey = `${raw.set}#${raw.collector_number}`;
      const current = byPrint.get(printKey);
      const candidateHasType = !!raw.printed_type_line;
      const currentHasType = !!current?.printed_type_line;
      if (!current || (candidateHasType && !currentHasType) || isBetterRepresentative(raw, current)) {
        byPrint.set(printKey, slimCard(raw));
      }
      return;
    }

    // reversible_card等の特殊レイアウトはトップレベルにoracle_idを持たず、DBのoracle_id NOT NULL
    // 制約やJSON.stringifyでのキー欠落（一括insertのキー不一致エラー）を招くため代表プリントに選ばない
    if (raw.lang === "en" && raw.oracle_id) {
      // 両面カードは裏面名（例: "Petty Theft"は"Brazen Borrower // Petty Theft"の裏面）だけで
      // 参照されることも多いため、名前は表裏どちらの面でも引けるようにインデックスする。
      // printed_nameも拾う: 版権上の理由で紙のカード名をそのまま使えないMTGOアリーナ専用
      // 再録（例: Marvel's Spider-Manの"Spider Manifestation"→MTGOでは"Leyline Weaver"表記）は
      // デッキソースがprinted_nameの方で記録していることが多い。isBetterRepresentativeが
      // digital=trueのプリントより紙のプリントを優先するので、この別名を拾えれば実在する
      // 紙カードの方（画像・日本語名あり）が代表プリントに選ばれる。
      const faceNames = raw.card_faces?.length ? raw.card_faces.map((f) => f.name) : [];
      const printedNames = raw.card_faces?.length
        ? raw.card_faces.map((f) => f.printed_name).filter(Boolean)
        : [raw.printed_name].filter(Boolean);
      // tier 0: カード自体の正式名（両面なら"A // B"）またはその表面名との完全一致
      // tier 1: 裏面名・印刷名のみでの一致（無関係な別カードと衝突しうる、弱い手がかり）
      const primaryNames = new Set([raw.name, faceNames[0]].filter(Boolean));
      for (const n of new Set([raw.name, ...faceNames, ...printedNames])) {
        const tier = primaryNames.has(n) ? 0 : 1;

        const exact = normalizeName(n);
        const currentExactTier = exactNameTier.get(exact);
        if (
          currentExactTier === undefined ||
          tier < currentExactTier ||
          (tier === currentExactTier && isBetterRepresentative(raw, byExactNameEn.get(exact)))
        ) {
          byExactNameEn.set(exact, slimCard(raw));
          exactNameTier.set(exact, tier);
        }

        const loose = looseNormalizeName(n);
        const currentLooseTier = looseNameTier.get(loose);
        if (
          currentLooseTier === undefined ||
          tier < currentLooseTier ||
          (tier === currentLooseTier && isBetterRepresentative(raw, byLooseNameEn.get(loose)))
        ) {
          byLooseNameEn.set(loose, slimCard(raw));
          looseNameTier.set(loose, tier);
        }
      }
    }
  });

  indexCache = { priceById, byExactNameEn, byLooseNameEn, byOracleIdJa };
  return indexCache;
}

/** 英語カード名（deck_cards.card_name等）から代表プリントを1件探す。表記ゆれに軽く対応する */
export function findEnglishCard(index, name) {
  const exact = normalizeName(name);
  const exactMatch = index.byExactNameEn.get(exact);
  if (exactMatch) return exactMatch;

  const loose = looseNormalizeName(name);
  return index.byLooseNameEn.get(loose) ?? null;
}

/**
 * oracle_id + 英語版の代表プリントと同じプリント（セット＋コレクター番号）で、日本語版プリントを
 * 探す。同じセットでも通常版/ショーケース版等でコレクター番号・アートが異なることがあるため、
 * セットコードだけでなくコレクター番号まで一致させる（例: Murders at Karlov Manorの
 * Underground Mortuaryは#271と#333で同じセット・別アート）。
 * 同じバージョンの日本語版が無ければnullを返す（呼び出し側は英語版の画像にフォールバックする想定）。
 */
export function findJapanesePrint(index, oracleId, enSetCode, enCollectorNumber) {
  const byPrint = index.byOracleIdJa.get(oracleId);
  if (!byPrint) return null;
  const direct = byPrint.get(`${enSetCode}#${enCollectorNumber}`);
  if (direct) return direct;

  // The List（plst）等の再録商品はコレクター番号が"元セット-元番号"形式
  // （例: "MH1-29"）で、元セットの絵柄をそのまま再録しているだけなので、
  // 直接一致が無ければ元セット側の日本語版で代用する。
  const listMatch = /^([A-Za-z0-9]+)-(.+)$/.exec(enCollectorNumber);
  if (listMatch) {
    const [, originSet, originNumber] = listMatch;
    return byPrint.get(`${originSet.toLowerCase()}#${originNumber}`) ?? null;
  }
  return null;
}

/**
 * カード名（テキスト）だけを日本語化したい場合の最終フォールバック。
 * 英語の代表プリント（最安値優先）がSecret Lair等の未ローカライズ専用商品だと、
 * 同じプリントの日本語版が存在せずfindJapanesePrintがnullを返すことがある
 * （例: Yoshimaru, Ever Faithfulの最安値はSecret Lair Dropだが、日本語版はKamigawa: Neon
 * Dynasty Commanderにしか無い）。カード名はプリントが違っても基本同じ訳語が使われるため、
 * 画像には使わずテキスト表示専用としてこの関数で拾う。
 */
export function findAnyJapaneseName(index, oracleId) {
  const byPrint = index.byOracleIdJa.get(oracleId);
  if (!byPrint) return null;
  // printed_nameが欠落しているプリント（Scryfall側のデータ欠け。例: Kamigawa: Neon Dynastyの
  // 一部showcase版で日本語名テキストが登録されていないケースがある）を代表に選んでしまうと
  // 名前がnullのまま返ってしまうため、実際に名前を持つプリントの中からのみ選ぶ。
  let best = null;
  for (const card of byPrint.values()) {
    if (!frontFacePrintedName(card)) continue;
    if (!best || isBetterRepresentative(card, best)) best = card;
  }
  return best ? frontFacePrintedName(best) : null;
}

/** scryfall_idから現在価格だけを引く（snapshot-prices.mjs用の軽量ルックアップ） */
export function findPriceById(index, scryfallId) {
  return index.priceById.get(scryfallId) ?? null;
}

export function frontFaceName(card) {
  return card.card_faces?.[0]?.name ?? card.name;
}

/**
 * Scryfallの日本語printed_nameには、読み方をふりがなとして全角括弧で埋め込んだもの
 * （例: "神（かみ）無（な）き祭（さい）殿（でん）"）が混じっているため、
 * 表示用に括弧とその中身を取り除く。
 */
function stripFurigana(name) {
  if (!name) return name;
  // まれに閉じ括弧が無いまま途切れている壊れたデータがある（例: "軍旗手（しゅ"）ため、
  // 通常の閉じ括弧ありパターンに加えて、文字列末尾の閉じられていない開き括弧以降も切り捨てる。
  return name.replace(/（[^（）]*）/g, "").replace(/（[^（）]*$/, "").trim();
}

export function frontFacePrintedName(card) {
  return stripFurigana(card.card_faces?.[0]?.printed_name ?? card.printed_name ?? null);
}

/**
 * ルールテキスト。両面カードは表裏それぞれのoracle_textを持つため、両方を連結して返す
 * （片面だけだと裏面の能力が読めなくなるため）。
 */
export function combinedOracleText(card) {
  if (card.card_faces?.length) {
    return card.card_faces
      .map((f) => f.oracle_text)
      .filter(Boolean)
      .join("\n//\n");
  }
  return card.oracle_text ?? null;
}

/**
 * ルールテキストの日本語訳（printed_text）。日本語版プリントの一部にしか無い。
 * oracle_textと同様、両面カードは表裏を連結する。
 */
export function combinedPrintedText(card) {
  if (card.card_faces?.length) {
    const texts = card.card_faces.map((f) => stripFurigana(f.printed_text)).filter(Boolean);
    return texts.length > 0 ? texts.join("\n//\n") : null;
  }
  return card.printed_text ? stripFurigana(card.printed_text) : null;
}

export function imageUris(card) {
  return card.image_uris ?? card.card_faces?.[0]?.image_uris ?? null;
}

export function toCardRow(card, oracleId) {
  const img = imageUris(card);
  return {
    scryfall_id: card.id,
    oracle_id: oracleId,
    name: frontFaceName(card),
    printed_name_ja: frontFacePrintedName(card),
    printed_text_ja: combinedPrintedText(card),
    set_code: card.set,
    set_name: card.set_name,
    rarity: card.rarity,
    collector_number: card.collector_number,
    lang: card.lang,
    image_uri_normal: img?.normal ?? null,
    image_uri_art_crop: img?.art_crop ?? null,
    mana_cost: card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? null,
    type_line: card.type_line ?? card.card_faces?.[0]?.type_line ?? null,
    legalities: card.legalities ?? {},
    released_at: card.released_at ?? null,
    finishes: card.finishes ?? [],
    is_showcase: card.is_showcase ?? false,
    is_borderless: card.border_color === "borderless",
    is_promo: card.promo ?? false,
  };
}
