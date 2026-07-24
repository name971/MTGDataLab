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
