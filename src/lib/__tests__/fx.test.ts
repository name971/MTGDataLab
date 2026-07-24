import { describe, expect, it } from "vitest";
import { formatJpy, toJpy } from "@/lib/fx";

describe("toJpy", () => {
  it("converts USD to JPY without rounding to a clean number", () => {
    expect(toJpy(43.84, 161.87)).toBeCloseTo(7096.38, 1);
  });

  it("does not round the result at all", () => {
    const result = toJpy(1, 161.876543);
    expect(result).toBe(161.876543);
  });
});

describe("formatJpy", () => {
  it("formats with a yen sign and thousands separators", () => {
    expect(formatJpy(7095.78)).toBe("¥7,096");
  });

  it("rounds only for display, not the underlying value", () => {
    expect(formatJpy(1840)).toBe("¥1,840");
  });
});
