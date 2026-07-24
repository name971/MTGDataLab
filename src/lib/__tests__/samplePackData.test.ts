import { describe, expect, it } from "vitest";
import { calculatePackEv, SAMPLE_SETS, COLLECTOR_SAMPLE_SETS, type SampleSet } from "@/lib/samplePackData";

describe("calculatePackEv", () => {
  it("sums cardCount × slot unit price across every slot", () => {
    const set: SampleSet = {
      setCode: "test",
      setName: "Test Set",
      releasedAt: "2024-01-01",
      packPriceJpy: 100,
      packImageUrl: null,
      slots: [{ slotName: "commons", cardCount: 2, probabilityByRarity: { common: 1 }, avgPriceJpy: 10, matchRate: 1 }],
    };
    expect(calculatePackEv(set)).toBe(20);
  });

  it("sums across multiple slots with different unit prices", () => {
    const set: SampleSet = {
      setCode: "test",
      setName: "Test Set",
      releasedAt: "2024-01-01",
      packPriceJpy: 100,
      packImageUrl: null,
      slots: [
        { slotName: "rare/mythic", cardCount: 1, probabilityByRarity: { rare: 0.875, mythic: 0.125 }, avgPriceJpy: 137.5, matchRate: 1 },
        { slotName: "foil wildcard", cardCount: 1, probabilityByRarity: { common: 0.7, uncommon: 0.3 }, avgPriceJpy: 20, matchRate: 1 },
      ],
    };
    expect(calculatePackEv(set)).toBeCloseTo(157.5, 5);
  });

  it("returns 0 for a set with no slots", () => {
    const set: SampleSet = {
      setCode: "test",
      setName: "Test Set",
      releasedAt: "2024-01-01",
      packPriceJpy: 100,
      packImageUrl: null,
      slots: [],
    };
    expect(calculatePackEv(set)).toBe(0);
  });
});

describe("SAMPLE_SETS", () => {
  it("has each set's every slot rarity probabilities summing to ~1.0", () => {
    for (const set of SAMPLE_SETS) {
      for (const slot of set.slots) {
        const total = Object.values(slot.probabilityByRarity).reduce(
          (sum, p) => sum + (p ?? 0),
          0,
        );
        expect(total).toBeCloseTo(1, 1);
      }
    }
  });

  it("computes a real-data-based EV in the same order of magnitude as the pack price for every set", () => {
    for (const set of SAMPLE_SETS) {
      const ev = calculatePackEv(set);
      expect(ev).toBeGreaterThan(set.packPriceJpy * 0.3);
      expect(ev).toBeLessThan(set.packPriceJpy * 3);
    }
  });

  it("has no duplicate set codes", () => {
    const codes = SAMPLE_SETS.map((s) => s.setCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("COLLECTOR_SAMPLE_SETS", () => {
  it("has each set's every slot rarity probabilities summing to ~1.0", () => {
    for (const set of COLLECTOR_SAMPLE_SETS) {
      for (const slot of set.slots) {
        const total = Object.values(slot.probabilityByRarity).reduce(
          (sum, p) => sum + (p ?? 0),
          0,
        );
        expect(total).toBeCloseTo(1, 1);
      }
    }
  });

  it("has no duplicate set codes", () => {
    const codes = COLLECTOR_SAMPLE_SETS.map((s) => s.setCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
