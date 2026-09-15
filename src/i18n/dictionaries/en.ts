import type ja from "./ja";

// jaと同じキー構造を強制する（キーの過不足をTSの型エラーで検知する）。
const en: typeof ja = {
  siteName: "MTG DataLab",
  nav: {
    popularCards: "Popular Cards",
    decks: "Decks",
    rankings: "Rankings",
    bannedCards: "Banned Cards",
  },
  searchPlaceholder: "Search for a card",
  searchButton: "Search",
  login: "Log in",
  logout: "Log out",
  footerLegal:
    "MTG DataLab is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards of the Coast. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.",
  cardHero: {
    backToCardData: "← Back to card data",
    cardDataLabel: "Card data",
    cardDataTooltip:
      "Showing the name and image of this print (automatically picked as the cheapest tournament-legal regular print; promos, special frames, and collaboration-exclusive versions are excluded). Price shown is the cheapest across all prints.",
    normalTab: "Normal",
    foilTab: "Foil",
    releasedOn: (date: string) => ` · Released: ${date}`,
    noPriceData: "No price data",
    fxReference: (usd: string, rate: string) => `FX reference ($${usd} × ¥${rate}/$)`,
    loading: "Loading...",
    loadingEllipsis: "Loading…",
    formatLegality: "Format Legality",
    galleryButtonTitle: (count: number) => `Browse image gallery (${count} total)`,
    allPrintsCount: (count: number) => `${count} prints total`,
    notTournamentLegalNote: "※This print is special and not legal for official tournament play",
    notTournamentLegalBadge: "Not legal",
    sortLabel: "Sort:",
    sortReleaseDate: "Release date",
    sortPrice: "Price",
    viewNormalPrices: "View normal prices",
    viewFoilPrices: "View foil prices",
    loadMore: (remaining: number, hasMoreOnServer: boolean) =>
      `Show more (${remaining}${hasMoreOnServer ? "+" : ""} left)`,
    loadMoreSimple: "Show more",
    loadMoreFromServer: (count: number) => `Load more (${count} left)`,
    close: "Close",
    priceUnknown: "Price unknown",
    noImage: "No image",
    printsListTitle: (name: string | null, shown: number, total: number) =>
      `${name ?? ""} prints (${shown}/${total})`,
  },
  home: {
    trendingHeading: "Cards on a Streak",
    mlRankingHeading: "Cards to Watch",
    mlRankingInfo:
      "Predicted with a machine learning model on the probability of a significant price move (up or down) within 7 days, ranked by confidence (tournament-played cards only). Historical Top 10 accuracy: ~73% for surges, ~95% for crashes.",
  },
  legality: {
    statusTitle: { legal: "Legal", not_legal: "Not legal", banned: "Banned", restricted: "Restricted (max 1)" },
    printNotLegalTitle: "This print is not tournament legal",
  },
  deckDetail: {
    kindLabel: { creature: "Creatures", spell: "Spells", land: "Lands" },
    commanderLabel: "Commander",
    sideboardLabel: "Sideboard",
    mainboardLabel: "Mainboard",
    arenaConvertedPrefix: "Arena est. ",
    listViewTab: "List (no images)",
    imageViewTab: "Images (grid)",
    arenaWildcardTooltip: "Wildcard estimate: Rare ¥1,500/4, Mythic ¥3,000/4, Common/Uncommon ¥0",
    arenaModeToggle: "Show MTG Arena estimate",
    noPriceData: "No price data",
    noImage: "No image",
    sectionTitle: (title: string, count: number) => `${title} (${count})`,
    total: (amount: string) => `Total: ${amount}`,
  },
};

export default en;
