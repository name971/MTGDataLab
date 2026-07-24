/**
 * TODO: decks / deck_cards（db/schema.sql）から取得したデータに差し替える。
 * priceJpyはScryfallの現在USD価格 × 為替レート(1USD=161.87円)で算出した実データ。
 */
export interface DeckCardEntry {
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  quantity: number;
  priceJpy: number;
  typeLine?: string;
  board: "main" | "side";
}

export interface DeckDetail {
  archetypeNameJa: string;
  archetypeNameEn: string;
  standing: string;
  eventName: string;
  cards: DeckCardEntry[];
}

/**
 * 各デッキのcardsは主要カードのみの部分リスト（60枚ちょうどの完全なデッキリストではない）。
 * そのため合計金額を出してもsampleDeckData.tsのmedianPriceJpyとは一致しない。
 * 実データ化する際は deck_cards に完全な60枚を入れる想定。
 */
const SAMPLE_DECKS: Record<string, DeckDetail> = {
  "std-domain-ramp": {
    archetypeNameJa: "ドメイン・ランプ",
    archetypeNameEn: "Domain Ramp",
    standing: "優勝",
    eventName: "Standard Challenge",
    cards: [
      { nameJa: "力線の束縛", nameEn: "Leyline Binding", artCropUrl: "https://cards.scryfall.io/art_crop/front/3/c/3c3ac3dd-35db-447f-8674-37b4680a1ef7.jpg", quantity: 4, priceJpy: 79, typeLine: "Enchantment", board: "main" },
      { nameJa: "生けるものの洞窟", nameEn: "Zoetic Cavern", artCropUrl: "https://cards.scryfall.io/art_crop/front/3/7/37f10035-bf05-460d-9390-433caa2570f4.jpg", quantity: 4, priceJpy: 52, typeLine: "Land", board: "main" },
      { nameJa: "群れの渡り", nameEn: "Herd Migration", artCropUrl: "https://cards.scryfall.io/art_crop/front/b/0/b0244a1f-e696-4223-9c14-22c2ca3cb738.jpg", quantity: 3, priceJpy: 34, typeLine: "Sorcery", board: "main" },
      { nameJa: "眠らずの蔓茎", nameEn: "Restless Vinestalk", artCropUrl: "https://cards.scryfall.io/art_crop/front/e/5/e5f3161d-3f69-4b06-ab73-c31fc0c1520c.jpg", quantity: 4, priceJpy: 58, typeLine: "Land Creature — Plant", board: "main" },
      { nameJa: "豆の木をのぼれ", nameEn: "Up the Beanstalk", artCropUrl: "https://cards.scryfall.io/art_crop/front/2/d/2d5e991f-23b2-4db0-a452-7755125b1fd2.jpg", quantity: 4, priceJpy: 353, typeLine: "Enchantment", board: "main" },
      { nameJa: "太陽降下", nameEn: "Sunfall", artCropUrl: "https://cards.scryfall.io/art_crop/front/3/2/32e29c7d-ed4b-4eff-b3c2-d99e5b63ef8d.jpg", quantity: 2, priceJpy: 121, typeLine: "Sorcery", board: "main" },
      { nameJa: "偉大なる統一者、アトラクサ", nameEn: "Atraxa, Grand Unifier", artCropUrl: "https://cards.scryfall.io/art_crop/front/d/6/d67be074-cdd4-41d9-ac89-0a0456c4e4b2.jpg", quantity: 2, priceJpy: 2611, typeLine: "Legendary Creature — Phyrexian Angel", board: "main" },
      { nameJa: "豆の木をのぼれ", nameEn: "Up the Beanstalk", artCropUrl: "https://cards.scryfall.io/art_crop/front/2/d/2d5e991f-23b2-4db0-a452-7755125b1fd2.jpg", quantity: 2, priceJpy: 353, board: "side" },
      { nameJa: "太陽降下", nameEn: "Sunfall", artCropUrl: "https://cards.scryfall.io/art_crop/front/3/2/32e29c7d-ed4b-4eff-b3c2-d99e5b63ef8d.jpg", quantity: 1, priceJpy: 121, board: "side" },
    ],
  },
};

export function getSampleDeckDetail(archetypeId: string): DeckDetail | null {
  return SAMPLE_DECKS[archetypeId] ?? null;
}

/** カード詳細ページの「このカードを使用しているデッキ」用の逆引き */
export function getArchetypesUsingCard(nameEn: string): { archetypeId: string; archetypeNameJa: string }[] {
  return Object.entries(SAMPLE_DECKS)
    .filter(([, deck]) => deck.cards.some((c) => c.nameEn === nameEn))
    .map(([archetypeId, deck]) => ({ archetypeId, archetypeNameJa: deck.archetypeNameJa }));
}
