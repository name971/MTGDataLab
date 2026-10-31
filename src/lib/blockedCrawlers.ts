// robots.txtでDisallowし、middlewareでも403を返すクローラー（robots.ts・middleware.ts共通）。
// 2026-10-31: Amzn-SearchBot（Amazonbotとは別名）が未登録のままカード/デッキページを巡回し、
// 無料枠のCPU時間超過の大半を占めていた（docs/incident-log.md参照）。
export const BLOCKED_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "CCBot",
  "Google-Extended",
  "anthropic-ai",
  "ClaudeBot",
  "Claude-Web",
  "Bytespider",
  "PerplexityBot",
  "Amazonbot",
  "Amzn-SearchBot",
  "Meta-ExternalAgent",
  "Diffbot",
  "Omgilibot",
  "YouBot",
];

const pattern = new RegExp(BLOCKED_CRAWLER_USER_AGENTS.map((ua) => ua.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

export function isBlockedCrawler(userAgent: string | null): boolean {
  return !!userAgent && pattern.test(userAgent);
}
