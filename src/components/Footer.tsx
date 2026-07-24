import Link from "next/link";

const SITE_NAME = "MTG DataLab";

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-neutral-200 px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 text-xs text-neutral-500">
        <nav className="flex flex-wrap gap-x-4 gap-y-2">
          <Link href="/rankings/standard" className="hover:text-neutral-700">
            カードランキング
          </Link>
          <Link href="/decks" className="hover:text-neutral-700">
            デッキランキング
          </Link>
          <Link href="/packs" className="hover:text-neutral-700">
            パックEV
          </Link>
        </nav>
        <p>
          {SITE_NAME}は、Fan Content
          Policyのもとで許可された非公式のファンコンテンツです。Wizards of the
          Coastによる承認・後援を受けたものではありません。使用されている素材の一部はWizards
          of the Coastの所有物です。©Wizards of the Coast LLC.
        </p>
        <p>
          カードデータ・画像:{" "}
          <a
            href="https://scryfall.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-700"
          >
            Scryfall
          </a>
          {" ・ "}トーナメントデータ:{" "}
          <a
            href="https://topdeck.gg"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-700"
          >
            TopDeck.gg
          </a>
          ・mtgo.com{" ・ "}為替レート:{" "}
          <a
            href="https://frankfurter.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-700"
          >
            Frankfurter
          </a>
          。価格は為替換算による参考値です。
        </p>
      </div>
    </footer>
  );
}
