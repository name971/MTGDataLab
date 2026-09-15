import type { Metadata } from "next";
import { Zen_Kaku_Gothic_New, Inter } from "next/font/google";
import "./globals.css";

// デザイン刷新（2026-08-29、ミニマル路線）: 本文の大半が日本語のため、Latin専用の
// Geistではなく日本語グリフを持つフォントに統一する。ウェイトは太字見出し用に900まで。
const zenKakuGothicNew = Zen_Kaku_Gothic_New({
  variable: "--font-zen-kaku-gothic-new",
  weight: ["400", "500", "700", "900"],
  subsets: ["latin"],
});

// 数字専用（2026-08-29、7書体比較でユーザーが選定）。価格・％等の数値だけInterに
// 差し替える（Zen Kaku Gothic Newの数字は日本語に合わせた丸みが強く判読性に不向き）。
const inter = Inter({
  variable: "--font-inter",
  weight: ["500", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MTG DataLab",
  description: "MTGカードの価格トレンド・トーナメント環境・パック期待値を可視化する非公式ファンサイト",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${zenKakuGothicNew.variable} ${inter.variable} h-full antialiased`}
    >
      <head>
        {/* TCGplayer Affiliate Program (Impact.com) のサイト所有権確認用。削除しないこと。 */}
        <meta
          name="impact-site-verification"
          {...({ value: "da22ae37-f54c-458a-ad6f-18d963df84a6" } as Record<string, string>)}
        />
      </head>
      {/* ヘッダー・フッター・メインのpx/py等のチャンクは英語版(app/[locale])と
          日本語版(現状はapp/[locale]配下に統一済み)どちらもapp/[locale]/layout.tsxが持つ。
          ここ(ルートレイアウト)は/auth・/api等、ロケール配下に無いルートも含めて全体に
          必要なhtml/body/フォント/共通metaタグだけを持つ。 */}
      <body className="flex min-h-full flex-col bg-white text-neutral-900">{children}</body>
    </html>
  );
}
