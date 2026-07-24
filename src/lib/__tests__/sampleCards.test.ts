import { describe, expect, it } from "vitest";
import { slugForCardName } from "@/lib/sampleCards";

describe("slugForCardName", () => {
  it("returns the slug for a known card name", () => {
    expect(slugForCardName("Solitude")).toBe("solitude");
    expect(slugForCardName("Ragavan, Nimble Pilferer")).toBe("ragavan");
  });

  it("returns null for a name with no registered slug", () => {
    expect(slugForCardName("Some Unregistered Card")).toBeNull();
  });
});
