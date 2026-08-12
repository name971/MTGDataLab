import type { Format } from "./formats";

export interface BannedCardEntry {
  name: string;
  format: Format;
  year: number;
  month?: number;
}

/**
 * 歴代禁止カード一覧（/banned-cards ページ用）。
 * 出典: MTG Wiki「Banned and restricted cards/Timeline」
 * https://mtg.fandom.com/wiki/Banned_and_restricted_cards/Timeline
 * （2026年8月10日禁止分のみ公式アナウンス https://magic.wizards.com/en/news/announcements/banned-and-restricted-august-10-2026 ）
 *
 * 「制限（restricted、1枚まで）」ではなく実際に使用不可となった「禁止（banned）」のみを対象にする。
 * 1997年1月以前のStandardには制限リストがあったが、1997年1月に制限リストが丸ごと禁止リストへ
 * 統合されたため、その時点で初めて使用不可になったカードは統合日（1997年1月）を禁止日として扱う。
 * 現時点ではStandardのみ収録（他フォーマットはpage.tsx側で「準備中」表示になる）。
 */
export const BANNED_CARDS: BannedCardEntry[] = [
  { name: "Channel", format: "Standard", year: 1995, month: 11 },
  { name: "Mind Twist", format: "Standard", year: 1996, month: 2 },
  { name: "Balance", format: "Standard", year: 1997, month: 1 },
  { name: "Black Vise", format: "Standard", year: 1997, month: 1 },
  { name: "Land Tax", format: "Standard", year: 1997, month: 1 },
  { name: "Hymn to Tourach", format: "Standard", year: 1997, month: 1 },
  { name: "Strip Mine", format: "Standard", year: 1997, month: 1 },
  { name: "Zuran Orb", format: "Standard", year: 1997, month: 6 },
  { name: "Tolarian Academy", format: "Standard", year: 1998, month: 12 },
  { name: "Windfall", format: "Standard", year: 1998, month: 12 },
  { name: "Dream Halls", format: "Standard", year: 1999, month: 3 },
  { name: "Earthcraft", format: "Standard", year: 1999, month: 3 },
  { name: "Fluctuator", format: "Standard", year: 1999, month: 3 },
  { name: "Lotus Petal", format: "Standard", year: 1999, month: 3 },
  { name: "Recurring Nightmare", format: "Standard", year: 1999, month: 3 },
  { name: "Time Spiral", format: "Standard", year: 1999, month: 3 },
  { name: "Memory Jar", format: "Standard", year: 1999, month: 3 },
  { name: "Mind Over Matter", format: "Standard", year: 1999, month: 6 },
  { name: "Skullclamp", format: "Standard", year: 2004, month: 6 },
  { name: "Arcbound Ravager", format: "Standard", year: 2005, month: 3 },
  { name: "Disciple of the Vault", format: "Standard", year: 2005, month: 3 },
  { name: "Darksteel Citadel", format: "Standard", year: 2005, month: 3 },
  { name: "Ancient Den", format: "Standard", year: 2005, month: 3 },
  { name: "Great Furnace", format: "Standard", year: 2005, month: 3 },
  { name: "Seat of the Synod", format: "Standard", year: 2005, month: 3 },
  { name: "Tree of Tales", format: "Standard", year: 2005, month: 3 },
  { name: "Vault of Whispers", format: "Standard", year: 2005, month: 3 },
  { name: "Jace, the Mind Sculptor", format: "Standard", year: 2011, month: 6 },
  { name: "Stoneforge Mystic", format: "Standard", year: 2011, month: 6 },
  { name: "Emrakul, the Promised End", format: "Standard", year: 2017, month: 1 },
  { name: "Smuggler's Copter", format: "Standard", year: 2017, month: 1 },
  { name: "Reflector Mage", format: "Standard", year: 2017, month: 1 },
  { name: "Felidar Guardian", format: "Standard", year: 2017, month: 4 },
  { name: "Aetherworks Marvel", format: "Standard", year: 2017, month: 6 },
  { name: "Attune with Aether", format: "Standard", year: 2018, month: 1 },
  { name: "Rogue Refiner", format: "Standard", year: 2018, month: 1 },
  { name: "Ramunap Ruins", format: "Standard", year: 2018, month: 1 },
  { name: "Rampaging Ferocidon", format: "Standard", year: 2018, month: 1 },
  { name: "Field of the Dead", format: "Standard", year: 2019, month: 10 },
  { name: "Oko, Thief of Crowns", format: "Standard", year: 2019, month: 11 },
  { name: "Once Upon a Time", format: "Standard", year: 2019, month: 11 },
  { name: "Veil of Summer", format: "Standard", year: 2019, month: 11 },
  { name: "Agent of Treachery", format: "Standard", year: 2020, month: 6 },
  { name: "Fires of Invention", format: "Standard", year: 2020, month: 6 },
  { name: "Cauldron Familiar", format: "Standard", year: 2020, month: 8 },
  { name: "Growth Spiral", format: "Standard", year: 2020, month: 8 },
  { name: "Teferi, Time Raveler", format: "Standard", year: 2020, month: 8 },
  { name: "Wilderness Reclamation", format: "Standard", year: 2020, month: 8 },
  { name: "Uro, Titan of Nature's Wrath", format: "Standard", year: 2020, month: 9 },
  { name: "Omnath, Locus of Creation", format: "Standard", year: 2020, month: 10 },
  { name: "Lucky Clover", format: "Standard", year: 2020, month: 10 },
  { name: "Escape to the Wilds", format: "Standard", year: 2020, month: 10 },
  { name: "Alrund's Epiphany", format: "Standard", year: 2022, month: 1 },
  { name: "Divide by Zero", format: "Standard", year: 2022, month: 1 },
  { name: "Faceless Haven", format: "Standard", year: 2022, month: 1 },
  { name: "The Meathook Massacre", format: "Standard", year: 2022, month: 10 },
  { name: "Fable of the Mirror-Breaker", format: "Standard", year: 2023, month: 5 },
  { name: "Invoke Despair", format: "Standard", year: 2023, month: 5 },
  { name: "Reckoner Bankbuster", format: "Standard", year: 2023, month: 5 },
  { name: "Cori-Steel Cutter", format: "Standard", year: 2025, month: 6 },
  { name: "Abuelo's Awakening", format: "Standard", year: 2025, month: 6 },
  { name: "Monstrous Rage", format: "Standard", year: 2025, month: 6 },
  { name: "Heartfire Hero", format: "Standard", year: 2025, month: 6 },
  { name: "Up the Beanstalk", format: "Standard", year: 2025, month: 6 },
  { name: "Hopeless Nightmare", format: "Standard", year: 2025, month: 6 },
  { name: "This Town Ain't Big Enough", format: "Standard", year: 2025, month: 6 },
  { name: "Vivi Ornitier", format: "Standard", year: 2025, month: 11 },
  { name: "Screaming Nemesis", format: "Standard", year: 2025, month: 11 },
  { name: "Proft's Eidetic Memory", format: "Standard", year: 2025, month: 11 },
  { name: "Badgermole Cub", format: "Standard", year: 2026, month: 8 },
  { name: "Gran-Gran", format: "Standard", year: 2026, month: 8 },
  { name: "Stormchaser's Talent", format: "Standard", year: 2026, month: 8 },
];
