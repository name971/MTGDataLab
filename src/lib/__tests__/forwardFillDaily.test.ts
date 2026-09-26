import { describe, expect, it } from "vitest";
import { forwardFillDaily } from "../priceArchiveR2";

describe("forwardFillDaily", () => {
  it("fills gaps with the previous value and extends to today", () => {
    const out = forwardFillDaily([{ date: "2026-09-20", usd: 1 }, { date: "2026-09-23", usd: 2 }], "2026-09-25");
    expect(out.map((p) => `${p.date}:${p.usd}`)).toEqual([
      "2026-09-20:1", "2026-09-21:1", "2026-09-22:1", "2026-09-23:2", "2026-09-24:2", "2026-09-25:2",
    ]);
  });
  it("does not extend stale prints to today", () => {
    const out = forwardFillDaily([{ date: "2026-09-01", usd: 1 }], "2026-09-25");
    expect(out).toEqual([{ date: "2026-09-01", usd: 1 }]);
  });
});
