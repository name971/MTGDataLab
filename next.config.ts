import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// `next dev`（Node.jsランタイム）でもgetCloudflareContext()経由でD1バインディング
// （PRICE_ARCHIVE_DB、価格履歴アーカイブ用、wrangler.jsonc参照）にアクセスできるようにする。
// 本番（Cloudflare Workers）では不要だが、ローカル開発時のみ効くのでどちらでも安全に呼べる。
initOpenNextCloudflareForDev();

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
