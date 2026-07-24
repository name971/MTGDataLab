import Image from "next/image";

const COLOR_SYMBOLS = new Set(["W", "U", "B", "R", "G"]);

/** "{2}{G}{G}"のようなScryfall形式のmana_costを{...}単位のシンボル配列に分割する */
function parseSymbols(manaCost: string): string[] {
  return [...manaCost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function Symbol({ symbol }: { symbol: string }) {
  // 色マナ（W/U/B/R/G）は用意済みのローカルSVGを使う。
  // 汎用（数値・X）・混成（W/U等）・ファイレクシアン（G/P等）はScryfall公式のSymbology API
  // （https://api.scryfall.com/symbology）が配布しているSVGをそのまま使う
  // （ファイル名は"/"を除いた記号名、例: "{2/W}" -> "2W.svg"）。
  const src = COLOR_SYMBOLS.has(symbol)
    ? `/mana/${symbol}.svg`
    : `https://svgs.scryfall.io/card-symbols/${symbol.replace("/", "")}.svg`;

  return <Image src={src} alt={symbol} width={16} height={16} className="h-4 w-4 shrink-0" />;
}

export default function ManaCost({ cost }: { cost: string | null }) {
  if (!cost) return null;
  const symbols = parseSymbols(cost);
  if (symbols.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {symbols.map((s, i) => (
        <Symbol key={i} symbol={s} />
      ))}
    </span>
  );
}
