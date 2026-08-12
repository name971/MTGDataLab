import type { Format } from "./formats";

export interface BannedCardEntry {
  name: string;
  format: Format;
  year: number;
  month?: number;
  /**
   * Scryfallの「通常版（非promo・非showcase・非borderless・非full_art）」プリントのうち
   * 最も古いものの画像URL。当時の雰囲気を出すため、DBの代表プリント選定ロジックとは無関係に
   * 一度だけ手動で調べて焼き込んでいる（禁止カード自体の追加頻度が低いため）。
   * 見つからなかった場合のみ、DB側（dbBannedCards.tsのgetEarliestCardImages）にフォールバックする。
   */
  imageUrl?: string;
}

/**
 * 歴代禁止カード一覧（/banned-cards ページ用）。
 * 出典: MTG Wiki「Banned and restricted cards/Timeline」
 * https://mtg.fandom.com/wiki/Banned_and_restricted_cards/Timeline
 * （2026年8月10日禁止分のみ公式アナウンス https://magic.wizards.com/en/news/announcements/banned-and-restricted-august-10-2026 ）
 *
 * 「制限（restricted、1枚まで）」ではなく実際に使用不可となった「禁止（banned)」のみを対象にする。
 * 1997年1月以前のStandardには制限リストがあったが、1997年1月に制限リストが丸ごと禁止リストへ
 * 統合されたため、その時点で初めて使用不可になったカードは統合日（1997年1月）を禁止日として扱う。
 * 現時点ではStandardのみ収録（他フォーマットはpage.tsx側で「準備中」表示になる）。
 */
export const BANNED_CARDS: BannedCardEntry[] = [
  { name: "Channel", format: "Standard", year: 1995, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/c/1/c1862c47-71cc-45a3-8805-a5ddc62e55ea.jpg?1783948678" },
  { name: "Mind Twist", format: "Standard", year: 1996, month: 2, imageUrl: "https://cards.scryfall.io/normal/front/e/e/eee9e106-a248-49d2-b8c8-6bbcd56ce739.jpg?1783948693" },
  { name: "Balance", format: "Standard", year: 1997, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/6/f/6f9ea46a-411f-40ce-a873-a905180093f4.jpg?1783948717" },
  { name: "Black Vise", format: "Standard", year: 1997, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/7/6/76ac72f8-5b1e-4d67-a796-ef69cde27424.jpg?1783948669" },
  { name: "Land Tax", format: "Standard", year: 1997, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/d/5/d53b20b0-67bc-4587-817b-efbf21cb2512.jpg?1783948083" },
  { name: "Hymn to Tourach", format: "Standard", year: 1997, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/e/b/eb9273ea-9a41-42e3-8c9c-0d50b127a818.jpg?1783947903" },
  { name: "Strip Mine", format: "Standard", year: 1997, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/e/7/e7880157-7f27-4f1b-9cdc-ab36a6252376.jpg?1783948354" },
  { name: "Zuran Orb", format: "Standard", year: 1997, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/3/a/3a9d1082-a862-45d4-9e5e-392e879fead6.jpg?1783947454" },
  { name: "Tolarian Academy", format: "Standard", year: 1998, month: 12, imageUrl: "https://cards.scryfall.io/normal/front/a/d/ad7ac9a5-340f-4509-826c-7b9416d47887.jpg?1783946296" },
  { name: "Windfall", format: "Standard", year: 1998, month: 12, imageUrl: "https://cards.scryfall.io/normal/front/2/a/2aef4608-5ba8-4636-b5e7-cac57c5c0608.jpg?1783946351" },
  { name: "Dream Halls", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/f/f/ff4a22d9-007b-4eb7-af9e-b5c2cae36238.jpg?1783946570" },
  { name: "Earthcraft", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/9/d/9dda7531-82a1-4f49-8858-601ddbc6e2bc.jpg?1783946620" },
  { name: "Fluctuator", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/9/2/92078408-e0e4-443e-b0fd-aac0ac651f46.jpg?1783946305" },
  { name: "Lotus Petal", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/6/c/6c877da3-68fa-41d0-8a24-8c79fcd8ecc1.jpg?1783946602" },
  { name: "Recurring Nightmare", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/c/8/c8173030-1c33-417c-b8e9-79231b6a85a7.jpg?1783946516" },
  { name: "Time Spiral", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/f/3/f3d62dbd-63db-4ac9-950f-9852627f23f2.jpg?1783946354" },
  { name: "Memory Jar", format: "Standard", year: 1999, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/a/1/a15d33d6-7213-4482-a1be-ac0a73644af6.jpg?1783946221" },
  { name: "Mind Over Matter", format: "Standard", year: 1999, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/6/e/6e091dd6-149f-46ea-bae0-224e79e3aacb.jpg?1783946523" },
  { name: "Skullclamp", format: "Standard", year: 2004, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/5/5/55318397-de3c-47ea-a088-72a24df5c8fa.jpg?1783944419" },
  { name: "Arcbound Ravager", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/7/2/72c1a731-7854-42b1-8719-ac3c2a269c1f.jpg?1783944429" },
  { name: "Disciple of the Vault", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/6/4/644359dc-3c4c-4291-876d-7390dc466877.jpg?1783944548" },
  { name: "Darksteel Citadel", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/c/5/c5d0e808-d67b-4ea3-9c04-d20269fe692c.jpg?1783944412" },
  { name: "Ancient Den", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/c/c/cc857fbd-8e0f-4bff-8f14-561c9925c484.jpg?1783944494" },
  { name: "Great Furnace", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/2/8/2877281d-c85d-4f32-b40d-828b93c4ee8e.jpg?1783944493" },
  { name: "Seat of the Synod", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/5/d/5da5587d-6b6c-4645-8cc9-2866d1e6911b.jpg?1783944493" },
  { name: "Tree of Tales", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/9/4/94db07aa-43d3-41b5-924e-60f1756b9c69.jpg?1783944493" },
  { name: "Vault of Whispers", format: "Standard", year: 2005, month: 3, imageUrl: "https://cards.scryfall.io/normal/front/7/3/73866487-33f4-4f64-b100-2c4ddadcd74e.jpg?1783944493" },
  { name: "Jace, the Mind Sculptor", format: "Standard", year: 2011, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/0/e/0e606072-a3aa-4300-ba90-ec92a721fa76.jpg?1783942061" },
  { name: "Stoneforge Mystic", format: "Standard", year: 2011, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/1/9/19557351-b65f-4b04-b971-66abdc07000a.jpg?1783942065" },
  { name: "Emrakul, the Promised End", format: "Standard", year: 2017, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/8/d/8d74a469-c71d-4773-99d3-5456b31df424.jpg?1783937526" },
  { name: "Smuggler's Copter", format: "Standard", year: 2017, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/7/8/7832abb5-5107-4603-904e-491b221bd3e3.jpg?1783937147" },
  { name: "Reflector Mage", format: "Standard", year: 2017, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/9/4/9473fe01-83f6-4432-ab01-f7953d2ca904.jpg?1783937896" },
  { name: "Felidar Guardian", format: "Standard", year: 2017, month: 4, imageUrl: "https://cards.scryfall.io/normal/front/4/4/44bdbed8-5d21-4bf5-8a32-9623b1139c85.jpg?1783936780" },
  { name: "Aetherworks Marvel", format: "Standard", year: 2017, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/8/8/884f6948-3e03-48c6-8be2-6f2539386c9d.jpg?1783937164" },
  { name: "Attune with Aether", format: "Standard", year: 2018, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/3/2/32b0707d-241e-4ced-9251-b16af4fef2cb.jpg?1783937182" },
  { name: "Rogue Refiner", format: "Standard", year: 2018, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/6/1/618652b4-7ce9-4994-9d16-68d2cc8644ef.jpg?1783936736" },
  { name: "Ramunap Ruins", format: "Standard", year: 2018, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/a/f/af11d41a-0d29-45e9-9d27-a41282b9e292.jpg?1783935995" },
  { name: "Rampaging Ferocidon", format: "Standard", year: 2018, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/3/9/39d3c658-1927-4af3-9077-88c4a669c730.jpg?1783935741" },
  { name: "Field of the Dead", format: "Standard", year: 2019, month: 10, imageUrl: "https://cards.scryfall.io/normal/front/4/7/470ca3f4-29aa-4c4c-8ff2-8cdd70c69943.jpg?1783932937" },
  { name: "Oko, Thief of Crowns", format: "Standard", year: 2019, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/3/4/3462a3d0-5552-49fa-9eb7-100960c55891.jpg?1783932594" },
  { name: "Once Upon a Time", format: "Standard", year: 2019, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/4/0/4034e5ba-9974-43e3-bde7-8d9b4586c3a4.jpg?1783932607" },
  { name: "Veil of Summer", format: "Standard", year: 2019, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/a/a/aa686c34-1c11-469f-93c2-f9891aea521f.jpg?1783932955" },
  { name: "Agent of Treachery", format: "Standard", year: 2020, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/c/c/cc6686e6-4535-49be-b0b3-e76464656cd2.jpg?1783933017" },
  { name: "Fires of Invention", format: "Standard", year: 2020, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/a/1/a12b16b0-f75f-42d8-9b24-947c1908e0f7.jpg?1783932623" },
  { name: "Cauldron Familiar", format: "Standard", year: 2020, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/9/a/9a539a23-8383-4525-82dd-acfe1d219fe9.jpg?1783932642" },
  { name: "Growth Spiral", format: "Standard", year: 2020, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/7/c/7c77a6b1-ef06-4da5-8e86-a5204216cb77.jpg?1783933648" },
  { name: "Teferi, Time Raveler", format: "Standard", year: 2020, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/5/c/5cb76266-ae50-4bbc-8f96-d98f309b02d3.jpg?1783933384" },
  { name: "Wilderness Reclamation", format: "Standard", year: 2020, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/5/4/54af08f7-9c6c-464e-b2f7-2b5803f36481.jpg?1783933661" },
  { name: "Uro, Titan of Nature's Wrath", format: "Standard", year: 2020, month: 9, imageUrl: "https://cards.scryfall.io/normal/front/a/0/a0b6a71e-56cb-4d25-8f2b-7a4f1b60900d.jpg?1783931516" },
  { name: "Omnath, Locus of Creation", format: "Standard", year: 2020, month: 10, imageUrl: "https://cards.scryfall.io/normal/front/4/e/4e4fb50c-a81f-44d3-93c5-fa9a0b37f617.jpg?1783929320" },
  { name: "Lucky Clover", format: "Standard", year: 2020, month: 10, imageUrl: "https://cards.scryfall.io/normal/front/4/b/4b5d23a6-3a23-4169-aea1-f10bf5153180.jpg?1783932584" },
  { name: "Escape to the Wilds", format: "Standard", year: 2020, month: 10, imageUrl: "https://cards.scryfall.io/normal/front/3/e/3e26c10b-179f-4a6e-bc8d-3ec1d6783fb9.jpg?1783932598" },
  { name: "Alrund's Epiphany", format: "Standard", year: 2022, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/c/9/c94fcb53-a7bd-4a80-a536-9fb0eb24261a.jpg?1783928270" },
  { name: "Divide by Zero", format: "Standard", year: 2022, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/1/9/1958d96e-ec44-48ab-80b1-5b01a24ac7b8.jpg?1783927380" },
  { name: "Faceless Haven", format: "Standard", year: 2022, month: 1, imageUrl: "https://cards.scryfall.io/normal/front/e/3/e3cd82e5-6072-4334-a493-01ca4ad6b4eb.jpg?1783928179" },
  { name: "The Meathook Massacre", format: "Standard", year: 2022, month: 10, imageUrl: "https://cards.scryfall.io/normal/front/0/8/08950015-eee5-4327-888c-82dfd13bb9ad.jpg?1783925613" },
  { name: "Fable of the Mirror-Breaker", format: "Standard", year: 2023, month: 5, imageUrl: "https://cards.scryfall.io/normal/front/2/4/24c0d87b-0049-4beb-b9cb-6f813b7aa7dc.jpg?1783923875" },
  { name: "Invoke Despair", format: "Standard", year: 2023, month: 5, imageUrl: "https://cards.scryfall.io/normal/front/3/5/35af9d5c-4449-4549-b549-c3ba4a67dee0.jpg?1783923885" },
  { name: "Reckoner Bankbuster", format: "Standard", year: 2023, month: 5, imageUrl: "https://cards.scryfall.io/normal/front/2/7/279acd17-6c17-427b-a69d-fc02442ff4a3.jpg?1783923822" },
  { name: "Cori-Steel Cutter", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/4/9/490eb213-9ae2-4b45-abec-6f1dfc83792a.jpg?1783907363" },
  { name: "Abuelo's Awakening", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/f/9/f93b725e-2b9c-4830-ac54-b2562afe09bb.jpg?1783913817" },
  { name: "Monstrous Rage", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/e/e/eef5a0ae-5907-42c9-a097-3f973737e392.jpg?1783915091" },
  { name: "Heartfire Hero", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/4/8/48ace959-66b2-40c8-9bff-fd7ed9c99a82.jpg?1783910820" },
  { name: "Up the Beanstalk", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/2/d/2d5e991f-23b2-4db0-a452-7755125b1fd2.jpg?1783915075" },
  { name: "Hopeless Nightmare", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/2/c/2c2ee817-9ca9-4f09-bc71-7994c19a9470.jpg?1783915106" },
  { name: "This Town Ain't Big Enough", format: "Standard", year: 2025, month: 6, imageUrl: "https://cards.scryfall.io/normal/front/b/b/bb206e27-da4d-4abe-9d8c-6d18c5f2f52a.jpg?1783911838" },
  { name: "Vivi Ornitier", format: "Standard", year: 2025, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/e/c/ecc1027a-8c07-44a0-bdde-fa2844cff694.jpg?1783906561" },
  { name: "Screaming Nemesis", format: "Standard", year: 2025, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/c/e/ce35e6fb-ff54-44c4-a216-7ddd37f46882.jpg?1783909465" },
  { name: "Proft's Eidetic Memory", format: "Standard", year: 2025, month: 11, imageUrl: "https://cards.scryfall.io/normal/front/a/f/af5b29b3-974c-4200-8df8-b072c11e1600.jpg?1783912906" },
  { name: "Badgermole Cub", format: "Standard", year: 2026, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/3/4/340c5799-4964-44dd-8c48-8f3f3aba5211.jpg?1786399172" },
  { name: "Gran-Gran", format: "Standard", year: 2026, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/f/a/fa434b41-e5f7-4989-865a-95db67b05cb1.jpg?1786399175" },
  { name: "Stormchaser's Talent", format: "Standard", year: 2026, month: 8, imageUrl: "https://cards.scryfall.io/normal/front/a/3/a36e682d-b43d-4e08-bf5b-70d7e924dbe5.jpg?1786399178" },
];
