/**
 * DB未接続時の一時的なslug→英語カード名マッピング。
 * 実運用では card_oracles.oracle_id をそのままslugとして使う想定。
 */
export const SAMPLE_CARD_SLUGS: Record<string, string> = {
  ragavan: "Ragavan, Nimble Pilferer",
  solitude: "Solitude",
  persist: "Persist",
  "wrenn-and-six": "Wrenn and Six",
  "orcish-bowmasters": "Orcish Bowmasters",
  "up-the-beanstalk": "Up the Beanstalk",
  sunfall: "Sunfall",
  sheoldred: "Sheoldred, the Apocalypse",
  "fable-of-the-mirror-breaker": "Fable of the Mirror-Breaker",
  "this-town-aint-big-enough": "This Town Ain't Big Enough",
  "force-of-will": "Force of Will",
  "restoration-angel": "Restoration Angel",
  kroxa: "Kroxa, Titan of Death's Hunger",
  wasteland: "Wasteland",
  daze: "Daze",
  "mishras-bauble": "Mishra's Bauble",
  "chalice-of-the-void": "Chalice of the Void",
  "mystic-remora": "Mystic Remora",
  "grim-monolith": "Grim Monolith",
  "sol-ring": "Sol Ring",
  "arcane-signet": "Arcane Signet",
  "cyclonic-rift": "Cyclonic Rift",
};

/**
 * 英語名→slugの逆引き。DB検索結果（oracle_id）を/cards/[slug]にリンクするために使う。
 * card_oracles.oracle_idにslug相当のカラムがまだ無いための暫定措置。
 */
const NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SAMPLE_CARD_SLUGS).map(([slug, name]) => [name, slug]),
);

export function slugForCardName(englishName: string): string | null {
  return NAME_TO_SLUG[englishName] ?? null;
}
