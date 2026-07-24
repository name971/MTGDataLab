/**
 * アーキタイプ判定エンジン
 *
 * Badaro/MTGOFormatData 形式のルール（JSON）を読み込んで、
 * デッキリストをアーキタイプに分類する軽量な実装。
 *
 * 参考: https://github.com/Badaro/MTGOFormatData
 *       https://github.com/Badaro/MTGOArchetypeParser (ロジックの考え方の参考元、コード自体は移植せず独自実装)
 *
 * reference/scripts/archetype-engine.ts から移植。日次バッチ側で
 * MTGOFormatData由来のJSONを読み込んでFormatDataを組み立て、classifyDeck(s)に渡す想定。
 */

/** デッキ内の1枚（カード名と枚数） */
export interface DeckCard {
  name: string;
  count: number;
}

/** 判定対象のデッキ（メイン/サイド） */
export interface Deck {
  mainboard: DeckCard[];
  sideboard: DeckCard[];
}

/**
 * MTGOFormatData の Condition.Type に相当。
 * "OrSideboard" 系（メインかサイドどちらかにあればOK）も含む。
 */
export type ConditionType =
  | "InMainboard"
  | "InSideboard"
  | "InMainOrSideboard"
  | "OneOrMoreInMainboard"
  | "OneOrMoreInSideboard"
  | "OneOrMoreInMainOrSideboard"
  | "TwoOrMoreInMainboard"
  | "TwoOrMoreInSideboard"
  | "TwoOrMoreInMainOrSideboard"
  | "DoesNotContain"
  | "DoesNotContainMainboard";

export interface Condition {
  Type: ConditionType;
  Cards: string[];
}

/** アーキタイプの亜種（Variant）。メイン定義にマッチした上で、さらに絞り込む */
export interface ArchetypeVariant {
  Name: string;
  Conditions: Condition[];
}

export interface ArchetypeDefinition {
  Name: string;
  Conditions: Condition[];
  Variants?: ArchetypeVariant[];
}

/** どのルールにもマッチしなかった時の受け皿定義 */
export interface FallbackDefinition {
  Name: string;
  CommonCards: string[];
}

export interface FormatData {
  format: string;
  archetypes: ArchetypeDefinition[];
  fallbacks: FallbackDefinition[];
  /** フォールバック採用の最低一致枚数。これ未満なら「未分類」のまま */
  fallbackMinOverlap?: number;
}

export interface ClassificationResult {
  archetype: string;
  variant?: string;
  matchedBy: "rule" | "fallback" | "unclassified";
  /** デバッグ・検証用に、どの条件がマッチしたかを残しておく */
  matchedConditions?: Condition[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** デッキ内に指定カードが存在するか（枚数問わず） */
function countInList(cards: DeckCard[], cardName: string): number {
  const target = normalizeName(cardName);
  const found = cards.find((c) => normalizeName(c.name) === target);
  return found ? found.count : 0;
}

/**
 * 1つの Condition がデッキに対して成立するかを判定する。
 * "OneOrMore" 系はリスト内のいずれか1種類以上が存在すればOK。
 * "TwoOrMore" 系はリスト内カードの合計枚数が2枚以上あればOK
 *（MTGOFormatDataの実装に合わせ、同一カード2枚でも異なる2種でもどちらでも可とする）。
 */
function evaluateCondition(condition: Condition, deck: Deck): boolean {
  const { Type, Cards } = condition;

  const mainCount = (name: string) => countInList(deck.mainboard, name);
  const sideCount = (name: string) => countInList(deck.sideboard, name);
  const bothCount = (name: string) => mainCount(name) + sideCount(name);

  switch (Type) {
    case "InMainboard":
      return Cards.every((c) => mainCount(c) > 0);

    case "InSideboard":
      return Cards.every((c) => sideCount(c) > 0);

    case "InMainOrSideboard":
      return Cards.every((c) => bothCount(c) > 0);

    case "OneOrMoreInMainboard":
      return Cards.some((c) => mainCount(c) > 0);

    case "OneOrMoreInSideboard":
      return Cards.some((c) => sideCount(c) > 0);

    case "OneOrMoreInMainOrSideboard":
      return Cards.some((c) => bothCount(c) > 0);

    case "TwoOrMoreInMainboard":
      return Cards.reduce((sum, c) => sum + mainCount(c), 0) >= 2;

    case "TwoOrMoreInSideboard":
      return Cards.reduce((sum, c) => sum + sideCount(c), 0) >= 2;

    case "TwoOrMoreInMainOrSideboard":
      return Cards.reduce((sum, c) => sum + bothCount(c), 0) >= 2;

    case "DoesNotContain":
      return Cards.every((c) => bothCount(c) === 0);

    case "DoesNotContainMainboard":
      return Cards.every((c) => mainCount(c) === 0);

    default:
      // 未知のConditionTypeは安全側に倒して「不一致」とする
      return false;
  }
}

/** Conditions配列は全てAND条件（MTGOFormatDataの仕様通り） */
function evaluateAllConditions(conditions: Condition[], deck: Deck): boolean {
  return conditions.every((cond) => evaluateCondition(cond, deck));
}

/**
 * どのアーキタイプにもマッチしなかったデッキを、
 * 一番カードが被っているFallback定義に寄せる。
 * 一致枚数が閾値未満なら「未分類」として扱う。
 */
function classifyByFallback(
  deck: Deck,
  fallbacks: FallbackDefinition[],
  minOverlap: number,
): ClassificationResult {
  let best: { name: string; overlap: number } | null = null;

  for (const fb of fallbacks) {
    const overlap = fb.CommonCards.reduce(
      (sum, cardName) => sum + (countInList(deck.mainboard, cardName) > 0 ? 1 : 0),
      0,
    );
    if (!best || overlap > best.overlap) {
      best = { name: fb.Name, overlap };
    }
  }

  if (best && best.overlap >= minOverlap) {
    return { archetype: best.name, matchedBy: "fallback" };
  }

  return { archetype: "未分類", matchedBy: "unclassified" };
}

/**
 * デッキを1つ分類する。
 * ルールは配列の先頭から順に評価し、最初にマッチしたものを採用する
 * （MTGOFormatData側がこの前提で定義順を管理している）。
 */
export function classifyDeck(deck: Deck, formatData: FormatData): ClassificationResult {
  for (const archetype of formatData.archetypes) {
    if (evaluateAllConditions(archetype.Conditions, deck)) {
      // メインルールにマッチ → Variantsがあればさらに絞り込む
      if (archetype.Variants && archetype.Variants.length > 0) {
        for (const variant of archetype.Variants) {
          if (evaluateAllConditions(variant.Conditions, deck)) {
            return {
              archetype: archetype.Name,
              variant: variant.Name,
              matchedBy: "rule",
              matchedConditions: [...archetype.Conditions, ...variant.Conditions],
            };
          }
        }
      }
      return {
        archetype: archetype.Name,
        matchedBy: "rule",
        matchedConditions: archetype.Conditions,
      };
    }
  }

  // どのルールにもマッチしなかった場合はFallbackへ
  return classifyByFallback(deck, formatData.fallbacks, formatData.fallbackMinOverlap ?? 4);
}

/** 複数デッキをまとめて分類する（日次バッチでの利用を想定） */
export function classifyDecks(decks: Deck[], formatData: FormatData): ClassificationResult[] {
  return decks.map((deck) => classifyDeck(deck, formatData));
}
