import { describe, expect, it } from "vitest";
import { classifyDeck, classifyDecks, type Deck, type FormatData } from "@/lib/archetypeEngine";

const formatData: FormatData = {
  format: "Modern",
  archetypes: [
    {
      Name: "Rakdos Scam",
      Conditions: [
        { Type: "InMainboard", Cards: ["Grief"] },
        { Type: "OneOrMoreInMainboard", Cards: ["Undying Malice", "Undying Evil"] },
      ],
      Variants: [
        {
          Name: "Rakdos Scam (Grief + Ragavan)",
          Conditions: [{ Type: "InMainboard", Cards: ["Ragavan, Nimble Pilferer"] }],
        },
      ],
    },
    {
      Name: "Living End",
      Conditions: [{ Type: "InMainboard", Cards: ["Living End"] }],
    },
    {
      Name: "No Ragavan Allowed",
      Conditions: [
        { Type: "InMainboard", Cards: ["Solitude"] },
        { Type: "DoesNotContainMainboard", Cards: ["Ragavan, Nimble Pilferer"] },
      ],
    },
    {
      Name: "Two Removal Spells",
      Conditions: [{ Type: "TwoOrMoreInMainboard", Cards: ["Lightning Bolt", "Prismatic Ending"] }],
    },
  ],
  fallbacks: [
    {
      Name: "Jund系ミッドレンジ",
      CommonCards: ["Fatal Push", "Thoughtseize", "Fable of the Mirror-Breaker"],
    },
  ],
  fallbackMinOverlap: 2,
};

function deck(mainboard: [string, number][], sideboard: [string, number][] = []): Deck {
  return {
    mainboard: mainboard.map(([name, count]) => ({ name, count })),
    sideboard: sideboard.map(([name, count]) => ({ name, count })),
  };
}

describe("classifyDeck", () => {
  it("matches the first rule whose conditions are all satisfied", () => {
    const result = classifyDeck(deck([["Grief", 4], ["Undying Evil", 2]]), formatData);
    expect(result.archetype).toBe("Rakdos Scam");
    expect(result.matchedBy).toBe("rule");
  });

  it("checks a Variant only after its parent archetype matches, and reports both", () => {
    const result = classifyDeck(
      deck([["Grief", 4], ["Undying Evil", 2], ["Ragavan, Nimble Pilferer", 4]]),
      formatData,
    );
    expect(result.archetype).toBe("Rakdos Scam");
    expect(result.variant).toBe("Rakdos Scam (Grief + Ragavan)");
  });

  it("evaluates OneOrMoreInMainboard as satisfied by any single card in the list", () => {
    const result = classifyDeck(deck([["Grief", 4], ["Undying Malice", 1]]), formatData);
    expect(result.archetype).toBe("Rakdos Scam");
  });

  it("requires every card in an InMainboard condition, not just one", () => {
    // Grief alone (no Undying Malice/Evil) must not match Rakdos Scam
    const result = classifyDeck(deck([["Grief", 4]]), formatData);
    expect(result.archetype).not.toBe("Rakdos Scam");
  });

  it("treats DoesNotContainMainboard as an exclusion", () => {
    const withRagavan = classifyDeck(
      deck([["Solitude", 4], ["Ragavan, Nimble Pilferer", 4]]),
      formatData,
    );
    expect(withRagavan.archetype).not.toBe("No Ragavan Allowed");

    const withoutRagavan = classifyDeck(deck([["Solitude", 4]]), formatData);
    expect(withoutRagavan.archetype).toBe("No Ragavan Allowed");
  });

  it("sums quantities across cards for TwoOrMoreInMainboard, not per-card", () => {
    // 1 Lightning Bolt + 1 Prismatic Ending = 2 total, should satisfy the condition
    const result = classifyDeck(
      deck([["Lightning Bolt", 1], ["Prismatic Ending", 1]]),
      formatData,
    );
    expect(result.archetype).toBe("Two Removal Spells");
  });

  it("is case- and whitespace-insensitive when matching card names", () => {
    const result = classifyDeck(deck([["  grief  ", 4], ["UNDYING EVIL", 2]]), formatData);
    expect(result.archetype).toBe("Rakdos Scam");
  });

  it("falls back to the closest fallback definition when no rule matches but overlap meets the threshold", () => {
    const result = classifyDeck(
      deck([["Fatal Push", 4], ["Thoughtseize", 4], ["Some Other Card", 4]]),
      formatData,
    );
    expect(result.archetype).toBe("Jund系ミッドレンジ");
    expect(result.matchedBy).toBe("fallback");
  });

  it("reports unclassified when overlap is below the fallback threshold", () => {
    const result = classifyDeck(deck([["Fatal Push", 4]]), formatData);
    expect(result.archetype).toBe("未分類");
    expect(result.matchedBy).toBe("unclassified");
  });
});

describe("classifyDecks", () => {
  it("classifies a batch of decks independently", () => {
    const results = classifyDecks(
      [deck([["Grief", 4], ["Undying Evil", 2]]), deck([["Living End", 4]])],
      formatData,
    );
    expect(results.map((r) => r.archetype)).toEqual(["Rakdos Scam", "Living End"]);
  });
});
