import { describe, expect, it } from "vitest";
import {
  resolveDisplayName,
  resolveFrontFaceName,
  resolveFrontFacePrintedName,
  resolveFrontFacePrintedTypeLine,
  resolveImageUris,
  type ScryfallCard,
} from "@/lib/scryfall";

describe("resolveDisplayName", () => {
  it("uses the Japanese printed name as main when available", () => {
    const result = resolveDisplayName({ name: "Solitude", printed_name: "孤独" });
    expect(result.main).toBe("孤独");
    expect(result.sub).toBe("Solitude");
  });

  it("falls back to the English name with no subtitle when no Japanese print exists", () => {
    const result = resolveDisplayName({ name: "Ragavan, Nimble Pilferer" });
    expect(result.main).toBe("Ragavan, Nimble Pilferer");
    expect(result.sub).toBeNull();
  });
});

describe("resolveImageUris", () => {
  it("uses the top-level image_uris for a normal single-faced card", () => {
    const card = {
      image_uris: { normal: "https://example.com/normal.jpg", art_crop: "https://example.com/art.jpg" },
    } as ScryfallCard;
    expect(resolveImageUris(card)?.normal).toBe("https://example.com/normal.jpg");
  });

  it("falls back to the front face's image_uris for a double-faced card", () => {
    const card = {
      card_faces: [
        { name: "Front", image_uris: { normal: "https://example.com/front.jpg", art_crop: "https://example.com/front-art.jpg" } },
        { name: "Back", image_uris: { normal: "https://example.com/back.jpg", art_crop: "https://example.com/back-art.jpg" } },
      ],
    } as ScryfallCard;
    expect(resolveImageUris(card)?.normal).toBe("https://example.com/front.jpg");
  });

  it("returns null when neither top-level nor face image_uris exist", () => {
    const card = {} as ScryfallCard;
    expect(resolveImageUris(card)).toBeNull();
  });
});

describe("resolveFrontFaceName", () => {
  it("returns the plain name for a single-faced card", () => {
    expect(resolveFrontFaceName({ name: "Ragavan, Nimble Pilferer" })).toBe(
      "Ragavan, Nimble Pilferer",
    );
  });

  it("returns only the front face's name for a double-faced card, not the combined 'X // Y' string", () => {
    const card = {
      name: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki",
      card_faces: [{ name: "Fable of the Mirror-Breaker" }, { name: "Reflection of Kiki-Jiki" }],
    };
    expect(resolveFrontFaceName(card)).toBe("Fable of the Mirror-Breaker");
  });
});

describe("resolveFrontFacePrintedName", () => {
  it("returns the top-level printed_name for a single-faced card", () => {
    expect(resolveFrontFacePrintedName({ printed_name: "孤独" })).toBe("孤独");
  });

  it("returns the front face's printed_name for a double-faced card", () => {
    const card = {
      card_faces: [{ name: "Fable", printed_name: "鏡割りの寓話" }, { name: "Reflection", printed_name: "キキジキの鏡" }],
    };
    expect(resolveFrontFacePrintedName(card)).toBe("鏡割りの寓話");
  });

  it("returns undefined when there is no Japanese printed name at all", () => {
    expect(resolveFrontFacePrintedName({})).toBeUndefined();
  });
});

describe("resolveFrontFacePrintedTypeLine", () => {
  it("returns the top-level printed_type_line when present", () => {
    expect(
      resolveFrontFacePrintedTypeLine({ printed_type_line: "伝説のクリーチャー — 猿・海賊" }),
    ).toBe("伝説のクリーチャー — 猿・海賊");
  });

  it("returns the front face's printed_type_line for a double-faced card", () => {
    const card = {
      card_faces: [
        { name: "Fable", printed_type_line: "伝説のエンチャント" },
        { name: "Reflection", printed_type_line: "伝説のクリーチャー" },
      ],
    };
    expect(resolveFrontFacePrintedTypeLine(card)).toBe("伝説のエンチャント");
  });

  it("returns undefined when no Japanese printing has a translated type line", () => {
    expect(resolveFrontFacePrintedTypeLine({})).toBeUndefined();
  });
});
