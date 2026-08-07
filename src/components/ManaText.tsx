/**
 * オラクルテキスト中の{T}/{W}/{2/W}のようなマナ・タップ等のシンボル表記を、Scryfallの
 * シンボルCDN画像に置き換えて表示する。ファイル名の導出規則はScryfallのSymbology API
 * （https://api.scryfall.com/symbology）のsvg_uriと同じで、波括弧の中身から"/"を除いた
 * ものがそのままファイル名になる（例: {W/U} -> WU.svg、{2/W} -> 2W.svg、{T} -> T.svg）。
 * この規則は固定なのでAPIを毎回叩く必要はなく、文字列変換だけで導出できる。
 */
const SYMBOL_PATTERN = /\{([^}]+)\}/g;

function symbolImageUrl(inner: string): string {
  return `https://svgs.scryfall.io/card-symbols/${inner.replace(/\//g, "")}.svg`;
}

// Scryfallの一部プリント（特に新セット）のprinted_text（日本語版含む翻訳側テキスト）に、
// "{1}{U}"や"{R}{R}"と打つべき箇所が"{1U}"や"{RR}"のように"}{"が抜けて連結された壊れた
// データが稀に混入している（oracle_text側は正しく分かれている）。本来のScryfallシンボルは
// ハイブリッドでも必ず"/"を挟む（例: "W/U"）、数字単体のコスト（例: "10"）、またはT/Q/S等の
// 英字1文字のいずれかで、"/"なしで英字が2文字以上連続する形は実在しないシンボル＝この種の
// 連結崩れと判定できる。該当した場合は数字部分（あれば）と各英字を別シンボルに分割して復元する。
const CONCATENATED_SYMBOLS = /^(\d*)([A-Za-z]{2,})$/;

function splitSymbol(inner: string): string[] {
  const match = inner.match(CONCATENATED_SYMBOLS);
  if (!match) return [inner];
  return [...(match[1] ? [match[1]] : []), ...match[2].split("")];
}

export default function ManaText({
  text,
  className,
  symbolSize = 14,
  align = "text-bottom",
}: {
  text: string;
  className?: string;
  /** シンボル画像の一辺のサイズ(px)。カード名の横に出す時は本文中より大きくしたい等の用途向け */
  symbolSize?: number;
  /**
   * "text-bottom"（デフォルト）は本文中でテキストのベースラインに揃う自然な見た目。
   * カード名のような大きな文字の横に置く場合はテキストの下に寄って見えるため、
   * 縦中央に揃えたい時は"middle"を使う。
   */
  align?: "text-bottom" | "middle";
}) {
  const parts: (string | { symbol: string })[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(SYMBOL_PATTERN)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    for (const symbol of splitSymbol(match[1])) parts.push({ symbol });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return (
    <span className={className}>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- ScryfallのシンボルCDN、next/imageの最適化対象外の小さな外部SVG
          <img
            key={i}
            src={symbolImageUrl(part.symbol)}
            alt={`{${part.symbol}}`}
            width={symbolSize}
            height={symbolSize}
            className={`mx-px inline-block ${
              align === "middle" ? "align-middle -translate-y-[1.7px]" : "align-text-bottom"
            }`}
          />
        ),
      )}
    </span>
  );
}
