import { describe, expect, it } from "vitest";
import { getArchetypesUsingCard, getSampleDeckDetail } from "@/lib/sampleDeckDetail";

describe("getArchetypesUsingCard", () => {
  it("finds archetypes whose deck list includes the given English card name", () => {
    const result = getArchetypesUsingCard("Up the Beanstalk");
    expect(result).toEqual([
      { archetypeId: "std-domain-ramp", archetypeNameJa: "ドメイン・ランプ" },
    ]);
  });

  it("returns an empty array when no deck uses the card", () => {
    expect(getArchetypesUsingCard("Ragavan, Nimble Pilferer")).toEqual([]);
  });
});

describe("getSampleDeckDetail", () => {
  it("returns null for an unknown archetype id", () => {
    expect(getSampleDeckDetail("does-not-exist")).toBeNull();
  });
});
