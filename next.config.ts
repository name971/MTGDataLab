import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cards.scryfall.io",
      },
      {
        protocol: "https",
        hostname: "svgs.scryfall.io",
      },
      {
        protocol: "https",
        hostname: "tcgplayer-cdn.tcgplayer.com",
      },
    ],
    // ScryfallはデフォルトのUser-Agentを送るリクエストを拒否するが、Next.jsの画像最適化
    // プロキシはupstream取得時にカスタムヘッダーを付けられないため、常に400になってしまう。
    // 全ての画像はScryfall CDNの既に最適化済みの画像なので、再最適化はせず直接配信する。
    unoptimized: true,
  },
};

export default nextConfig;
