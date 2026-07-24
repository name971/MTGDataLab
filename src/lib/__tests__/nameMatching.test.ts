import { describe, expect, it } from "vitest";
import { normalizeCardName } from "@/lib/nameMatching";

describe("normalizeCardName", () => {
  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeCardName("  Ragavan, Nimble Pilferer  ")).toBe(
      "ragavan, nimble pilferer",
    );
  });

  it("collapses internal repeated whitespace to a single space", () => {
    expect(normalizeCardName("Ragavan,   Nimble  Pilferer")).toBe(
      "ragavan, nimble pilferer",
    );
  });

  it("strips accent marks so different unicode encodings of the same word compare equal", () => {
    const precomposed = "Séance"; // e-acute as a single precomposed codepoint
    const combining = "Séance"; // e + combining acute accent (U+0301)
    expect(precomposed).not.toBe(combining); // sanity check: the raw strings really do differ
    expect(normalizeCardName(precomposed)).toBe(normalizeCardName(combining));
    expect(normalizeCardName(precomposed)).toBe("seance");
  });

  it("normalizes split/double-faced card slash notation to a single canonical form", () => {
    expect(normalizeCardName("Fire/Ice")).toBe("fire // ice");
    expect(normalizeCardName("Fire // Ice")).toBe("fire // ice");
    expect(normalizeCardName("Fire  /  Ice")).toBe("fire // ice");
  });
});
