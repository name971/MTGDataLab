export interface PricedDeckCard {
  priceJpy: number | null;
  quantity: number;
}

/** 価格データがあるカードだけの合計金額（円） */
export function totalPriceJpy(cards: PricedDeckCard[]): number {
  return cards.reduce((sum, c) => sum + (c.priceJpy ?? 0) * c.quantity, 0);
}

export function formatJpy(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}

// MTG Arenaのワイルドカード1枚あたりの実質価値をJPYに換算する目安。ワイルドカード4枚で
// レア1500円/神話レア3000円ぶんの購入プランを単価に割り戻した値。コモン・アンコモンは
// ワイルドカードがほぼ余るため0円扱いにする（src/lib/dbArchetypeStats.tsと同じ考え方）。
const ARENA_WILDCARD_JPY: Record<string, number> = {
  common: 0,
  uncommon: 0,
  rare: 1500 / 4,
  mythic: 3000 / 4,
};

export function arenaPriceJpy(rarity: string | null | undefined): number {
  if (!rarity) return 0;
  return ARENA_WILDCARD_JPY[rarity] ?? 0;
}

export interface RarityDeckCard {
  rarity: string | null;
  quantity: number;
}

/** デッキ全体のMTG Arenaワイルドカード換算合計（円） */
export function totalArenaPriceJpy(cards: RarityDeckCard[]): number {
  return cards.reduce((sum, c) => sum + arenaPriceJpy(c.rarity) * c.quantity, 0);
}
