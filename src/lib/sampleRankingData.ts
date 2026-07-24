import type { Format } from "./formats";

/**
 * priceJpy・usageRatePctはsrc/lib/applyDbPrices.tsでDBの実データ（card_price_snapshots /
 * card_usage_stats）に差し替えられる。ここでの値は両方ともDBに無い場合のフォールバック値。
 * priceChangePct（3日変化率）はtrending_scoresが3日分のスナップショット蓄積待ちのため
 * 引き続きダミー値。arenaPriceJpyはMTGO/Arenaのデジタル経済の参考値で、紙のカードとは
 * 別の価格体系のため実データ化していない（priceJpyとの比率をそのまま維持）。
 */
export interface RankingRow {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  priceJpy: number;
  /** スタンダードのみ: テーブルトップ/Arena価格を並列表示 */
  arenaPriceJpy?: number;
  priceChangePct: number;
  usageRatePct: number;
  /** カードの色（WUBRG順、mana_costから抽出）。色フィルタ用 */
  colors?: string[];
}

const RANKING_BY_FORMAT: Record<Format, RankingRow[]> = {
  Standard: [
    {
      oracleId: "up-the-beanstalk",
      nameJa: "豆の木をのぼれ",
      nameEn: "Up the Beanstalk",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/2/d/2d5e991f-23b2-4db0-a452-7755125b1fd2.jpg",
      priceJpy: 353,
      arenaPriceJpy: 311,
      priceChangePct: 12.4,
      usageRatePct: 19.3,
    },
    {
      oracleId: "sunfall",
      nameJa: "太陽降下",
      nameEn: "Sunfall",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/3/2/32e29c7d-ed4b-4eff-b3c2-d99e5b63ef8d.jpg",
      priceJpy: 121,
      arenaPriceJpy: 104,
      priceChangePct: -1.8,
      usageRatePct: 4.8,
    },
    {
      oracleId: "sheoldred",
      nameJa: "黙示録、シェオルドレッド",
      nameEn: "Sheoldred, the Apocalypse",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/d/6/d67be074-cdd4-41d9-ac89-0a0456c4e4b2.jpg",
      priceJpy: 15928,
      arenaPriceJpy: 14160,
      priceChangePct: -3.3,
      usageRatePct: 27.6,
    },
  ],
  Pioneer: [
    {
      oracleId: "fable-of-the-mirror-breaker",
      nameJa: "鏡割りの寓話",
      nameEn: "Fable of the Mirror-Breaker",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/2/4/24c0d87b-0049-4beb-b9cb-6f813b7aa7dc.jpg",
      priceJpy: 1018,
      priceChangePct: 6.1,
      usageRatePct: 24.8,
    },
    {
      oracleId: "restoration-angel",
      nameJa: "修復の天使",
      nameEn: "Restoration Angel",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/f/1/f17f85d3-58e5-4128-90c5-98b524256af8.jpg",
      priceJpy: 58,
      priceChangePct: -0.9,
      usageRatePct: 11.4,
    },
    {
      oracleId: "kroxa",
      nameJa: "死の飢えのタイタン、クロクサ",
      nameEn: "Kroxa, Titan of Death's Hunger",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/c/e/cee0459b-9aac-4d2f-abe4-4d5fedde7eb8.jpg",
      priceJpy: 531,
      priceChangePct: 3.4,
      usageRatePct: 9.7,
    },
  ],
  Modern: [
    {
      oracleId: "ragavan",
      nameJa: "敏捷なこそ泥、ラガバン",
      nameEn: "Ragavan, Nimble Pilferer",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/a/9/a9738cda-adb1-47fb-9f4c-ecd930228c4d.jpg",
      priceJpy: 7096,
      priceChangePct: 4.2,
      usageRatePct: 38.4,
    },
    {
      oracleId: "wrenn-and-six",
      nameJa: "レンと六番",
      nameEn: "Wrenn and Six",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/5/b/5bd498cc-a609-4457-9325-6888d59ca36f.jpg",
      priceJpy: 1446,
      priceChangePct: -5.4,
      usageRatePct: 15.9,
    },
    {
      oracleId: "orcish-bowmasters",
      nameJa: "オークの弓使い",
      nameEn: "Orcish Bowmasters",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/7/c/7c024bae-5631-4e20-ac69-df392ac9e109.jpg",
      priceJpy: 7272,
      priceChangePct: 7.8,
      usageRatePct: 41.2,
    },
  ],
  Legacy: [
    {
      oracleId: "solitude",
      nameJa: "孤独",
      nameEn: "Solitude",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/4/7/47a6234f-309f-4e03-9263-66da48b57153.jpg",
      priceJpy: 5511,
      priceChangePct: -2.6,
      usageRatePct: 22.1,
    },
    {
      oracleId: "wasteland",
      nameJa: "不毛の大地",
      nameEn: "Wasteland",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/a/a/aaafb9bc-7cea-4624-a227-595544fa42b0.jpg",
      priceJpy: 4574,
      priceChangePct: 1.5,
      usageRatePct: 18.7,
    },
    {
      oracleId: "daze",
      nameJa: "目くらまし",
      nameEn: "Daze",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/f/0/f05e9a3e-8a35-4687-85cb-e31b3927a5e2.jpg",
      priceJpy: 437,
      priceChangePct: -4.1,
      usageRatePct: 12.3,
    },
  ],
  Vintage: [
    {
      oracleId: "chalice-of-the-void",
      nameJa: "虚空の杯",
      nameEn: "Chalice of the Void",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/1/f/1f0d2e8e-c8f2-4b31-a6ba-6283fc8740d4.jpg",
      priceJpy: 2413,
      priceChangePct: 2.2,
      usageRatePct: 14.6,
    },
    {
      oracleId: "mystic-remora",
      nameJa: "神秘的負荷",
      nameEn: "Mystic Remora",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/4/0/40140991-cffa-4b52-9a25-37e9a8aa9ddd.jpg",
      priceJpy: 2051,
      priceChangePct: -1.2,
      usageRatePct: 9.8,
    },
    {
      oracleId: "grim-monolith",
      nameJa: "厳かなモノリス",
      nameEn: "Grim Monolith",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/9/d/9ddc9fe1-17c8-4e1d-aeb8-c4214e881280.jpg",
      priceJpy: 76471,
      priceChangePct: 8.9,
      usageRatePct: 6.2,
    },
  ],
  Commander: [
    {
      oracleId: "sol-ring",
      nameJa: "太陽の指輪",
      nameEn: "Sol Ring",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg",
      priceJpy: 298,
      priceChangePct: 0.4,
      usageRatePct: 68.9,
    },
    {
      oracleId: "arcane-signet",
      nameJa: "秘儀の印鑑",
      nameEn: "Arcane Signet",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/1/c/1cad1bd2-7c56-4ce0-99a6-b2a49c1288dd.jpg",
      priceJpy: 112,
      priceChangePct: -0.6,
      usageRatePct: 54.3,
    },
    {
      oracleId: "cyclonic-rift",
      nameJa: "サイクロンの裂け目",
      nameEn: "Cyclonic Rift",
      artCropUrl: "https://cards.scryfall.io/art_crop/front/d/f/dfb7c4b9-f2f4-4d4e-baf2-86551c8150fe.jpg",
      priceJpy: 6496,
      priceChangePct: -2.9,
      usageRatePct: 31.5,
    },
  ],
};

export function getSampleRanking(format: Format): RankingRow[] {
  return RANKING_BY_FORMAT[format];
}
