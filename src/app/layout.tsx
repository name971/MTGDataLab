import type { Metadata } from "next";
import { Zen_Kaku_Gothic_New, IBM_Plex_Mono } from "next/font/google";
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

// 価格・％等の数字専用（2026-08-29、ユーザー指摘「数字の書体が気に入らない」）。
// Zen Kaku Gothic Newの数字は日本語に合わせた丸みが強く、価格のような細かい桁の
// 判読性を優先したい箇所には向かないため、数字だけ等幅のIBM Plex Monoに差し替える。
const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["500", "600"],
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
      className={`${zenKakuGothicNew.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white text-neutral-900">
        <Header />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
