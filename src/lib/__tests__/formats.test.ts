import { describe, expect, it } from "vitest";
import { defaultPeriodDays, formatSlug } from "@/lib/formats";

describe("defaultPeriodDays", () => {
  it("returns 14 for Standard", () => {
    expect(defaultPeriodDays("Standard")).toBe(14);
  });

  it("returns 30 for every other format", () => {
    expect(defaultPeriodDays("Modern")).toBe(30);
    expect(defaultPeriodDays("Commander")).toBe(30);
    expect(defaultPeriodDays("Vintage")).toBe(30);
  });
});

describe("formatSlug", () => {
  it("lowercases the format name", () => {
    expect(formatSlug("Standard")).toBe("standard");
    expect(formatSlug("Commander")).toBe("commander");
  });
});
