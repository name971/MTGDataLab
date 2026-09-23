import type { MetadataRoute } from "next";

// 2026-09-23判明: robots.txt自体が存在せず、AIクローラーも含めて完全に無制限だった。
// Cloudflareのアクセス統計（Colo別）でリクエストの約8割が米国データセンター経由と
// 日本語サイトとして不自然な偏りがあり、AIクローラー/LLMのブラウジング機能による
// アクセスが疑われる（ユーザー指摘）。無料枠のCPU時間超過・高いエラー率とも符合するため、
// まず既知のAIクローラーを明示的に締め出す。
const AI_CRAWLER_USER_AGENTS = [
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
  "Meta-ExternalAgent",
  "Diffbot",
  "Omgilibot",
  "YouBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      ...AI_CRAWLER_USER_AGENTS.map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
  };
}
