import { describe, expect, it } from "vitest";
import { parseScryfallQuery } from "../scryfallQuerySyntax";

describe("parseScryfallQuery", () => {
  it("t: c: r: を解釈する", () => {
    const f = parseScryfallQuery("t:creature c:r r:rare");
    expect(f.types).toEqual(["creature"]);
    expect(f.colors).toEqual(["R"]);
    expect(f.rarities).toEqual(["rare"]);
  });

  it("cmc>=N をマナ総量バケットに変換する", () => {
    const f = parseScryfallQuery("cmc>=4");
    expect(f.mvBuckets).toEqual(["4", "5", "6", "7+"]);
  });

  it("cmc:N（完全一致）をマナ総量バケットに変換する", () => {
    const f = parseScryfallQuery("cmc:2");
    expect(f.mvBuckets).toEqual(["2"]);
  });

  it("o:\"...\" のクォート付き語句をルールテキスト検索にする", () => {
    const f = parseScryfallQuery('o:"draw a card"');
    expect(f.text).toBe("draw a card");
  });

  it("f: をフォーマットに変換する（大文字小文字を無視）", () => {
    const f = parseScryfallQuery("f:standard");
    expect(f.formats).toEqual(["Standard"]);
  });

  it("jpy>= / jpy<= を価格帯に変換する", () => {
    const f = parseScryfallQuery("jpy>=100 jpy<=5000");
    expect(f.priceMin).toBe(100);
    expect(f.priceMax).toBe(5000);
  });

  it("c:colorless を無色指定にする", () => {
    const f = parseScryfallQuery("c:colorless");
    expect(f.colorlessOnly).toBe(true);
  });

  it("裸の単語をカード名検索にする", () => {
    const f = parseScryfallQuery("lightning bolt");
    expect(f.name).toBe("lightning bolt");
  });

  it("未対応キーワードは無視し、名前検索に混ぜない", () => {
    const f = parseScryfallQuery("pow>=4 bolt");
    expect(f.name).toBe("bolt");
  });
});
