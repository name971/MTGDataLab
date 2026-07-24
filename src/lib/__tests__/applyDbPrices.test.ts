import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cardData", () => ({
  getOracleIdsByNames: vi.fn(),
  getJpyPricesByOracleIds: vi.fn(),
  getUsageRatesByOracleIds: vi.fn(),
}));

import { getOracleIdsByNames, getJpyPricesByOracleIds, getUsageRatesByOracleIds } from "@/lib/cardData";
import { applyDbPrices, applyDbUsageRates } from "@/lib/applyDbPrices";
import type { RankingRow } from "@/lib/sampleRankingData";

function row(overrides: Partial<RankingRow>): RankingRow {
  return {
    oracleId: "slug",
    nameJa: "テストカード",
    nameEn: "Test Card",
    artCropUrl: "https://example.com/art.jpg",
    priceJpy: 999,
    priceChangePct: 1,
    usageRatePct: 1,
    ...overrides,
  };
}

describe("applyDbPrices", () => {
  it("overrides priceJpy for cards with a matching DB snapshot", async () => {
    (getOracleIdsByNames as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["Ragavan, Nimble Pilferer", "oid-1"]]),
    );
    (getJpyPricesByOracleIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["oid-1", 7096]]),
    );

    const rows = [row({ nameEn: "Ragavan, Nimble Pilferer", priceJpy: 6570 })];
    const result = await applyDbPrices(rows);
    expect(result[0].priceJpy).toBe(7096);
  });

  it("leaves the sample priceJpy untouched for cards not found in the DB", async () => {
    (getOracleIdsByNames as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    (getJpyPricesByOracleIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    const rows = [row({ nameEn: "Some Unimported Card", priceJpy: 500 })];
    const result = await applyDbPrices(rows);
    expect(result[0].priceJpy).toBe(500);
  });

  it("does not mutate the original row objects", async () => {
    (getOracleIdsByNames as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["Solitude", "oid-2"]]),
    );
    (getJpyPricesByOracleIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["oid-2", 5511]]),
    );

    const original = row({ nameEn: "Solitude", priceJpy: 5100 });
    await applyDbPrices([original]);
    expect(original.priceJpy).toBe(5100);
  });
});

describe("applyDbUsageRates", () => {
  it("overrides usageRatePct for cards with a matching DB stat in that format", async () => {
    (getOracleIdsByNames as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["Ragavan, Nimble Pilferer", "oid-1"]]),
    );
    (getUsageRatesByOracleIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["oid-1", 41.2]]),
    );

    const rows = [row({ nameEn: "Ragavan, Nimble Pilferer", usageRatePct: 38.4 })];
    const result = await applyDbUsageRates(rows, "Modern");
    expect(result[0].usageRatePct).toBe(41.2);
    expect(getUsageRatesByOracleIds).toHaveBeenCalledWith("Modern", ["oid-1"]);
  });

  it("leaves the sample usageRatePct untouched for cards not found in the DB", async () => {
    (getOracleIdsByNames as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    (getUsageRatesByOracleIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    const rows = [row({ nameEn: "Some Unimported Card", usageRatePct: 5 })];
    const result = await applyDbUsageRates(rows, "Standard");
    expect(result[0].usageRatePct).toBe(5);
  });
});
