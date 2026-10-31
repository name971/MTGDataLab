import { describe, expect, it } from "vitest";
import { isBlockedCrawler } from "./blockedCrawlers";

describe("isBlockedCrawler", () => {
  it("blocks listed crawlers case-insensitively", () => {
    expect(isBlockedCrawler("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/119.0.6045.214 Safari/537.36")).toBe(true);
    expect(isBlockedCrawler("mozilla/5.0 (compatible; gptbot/1.0)")).toBe(true);
  });
  it("lets browsers, search engines and link previews through", () => {
    expect(isBlockedCrawler("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe(false);
    expect(isBlockedCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(false);
    expect(isBlockedCrawler("facebookexternalhit/1.1")).toBe(false);
    expect(isBlockedCrawler(null)).toBe(false);
  });
});
