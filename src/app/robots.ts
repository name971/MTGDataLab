import type { MetadataRoute } from "next";
import { BLOCKED_CRAWLER_USER_AGENTS } from "@/lib/blockedCrawlers";

// 2026-09-23判明: robots.txt自体が存在せず、AIクローラーも含めて完全に無制限だった。
// Cloudflareのアクセス統計（Colo別）でリクエストの約8割が米国データセンター経由と
// 日本語サイトとして不自然な偏りがあり、AIクローラー/LLMのブラウジング機能による
// アクセスが疑われる（ユーザー指摘）。無料枠のCPU時間超過・高いエラー率とも符合するため、
// まず既知のAIクローラーを明示的に締め出す。

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      ...BLOCKED_CRAWLER_USER_AGENTS.map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
  };
}
