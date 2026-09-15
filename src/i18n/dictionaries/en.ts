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
};

export default en;
