import type { Metadata } from "next";
import { Zen_Kaku_Gothic_New, Inter } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

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
      <body className="flex min-h-full flex-col bg-white text-neutral-900">
        <Header />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
