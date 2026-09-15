import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { LOCALES, isLocale } from "@/i18n/config";
import { notFound } from "next/navigation";
import LocaleHtmlLang from "@/components/LocaleHtmlLang";

// /ja・/enの2つを静的に用意する（generateStaticParamsに無い値はnotFoundへ、
// isLocaleの再チェックはmiddlewareを経由しない直接アクセス・prefetch対策）。
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <>
      {/* ルートレイアウト(app/layout.tsx)の<html lang="ja">は/auth等ロケール外のルートも
          含めた既定値。ロケール配下ではクライアント側でlang属性だけ上書きする
          (<html>タグ自体はルートレイアウトにしか置けないNext.jsの制約のため)。 */}
      <LocaleHtmlLang locale={locale} />
      <Header locale={locale} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <Footer locale={locale} />
    </>
  );
}
