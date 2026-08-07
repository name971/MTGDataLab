import { meetsMinQueryLength } from "./searchQuery";

/** TODO: db/search-design.sql の pg_trgm検索クエリに差し替える（card_oracles.name / printed_name_ja） */
export interface SearchIndexEntry {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
}

export const SAMPLE_SEARCH_INDEX: SearchIndexEntry[] = [
  { oracleId: "ragavan", nameJa: "敏捷なこそ泥、ラガバン", nameEn: "Ragavan, Nimble Pilferer", artCropUrl: "https://cards.scryfall.io/art_crop/front/a/9/a9738cda-adb1-47fb-9f4c-ecd930228c4d.jpg" },
  { oracleId: "solitude", nameJa: "孤独", nameEn: "Solitude", artCropUrl: "https://cards.scryfall.io/art_crop/front/4/7/47a6234f-309f-4e03-9263-66da48b57153.jpg" },
  { oracleId: "persist", nameJa: "頑強", nameEn: "Persist", artCropUrl: "https://cards.scryfall.io/art_crop/front/b/7/b7a56356-91bf-42f5-ab21-af2c48e78fc3.jpg" },
  { oracleId: "wrenn-and-six", nameJa: "レンと六番", nameEn: "Wrenn and Six", artCropUrl: "https://cards.scryfall.io/art_crop/front/5/b/5bd498cc-a609-4457-9325-6888d59ca36f.jpg" },
  { oracleId: "orcish-bowmasters", nameJa: "オークの弓使い", nameEn: "Orcish Bowmasters", artCropUrl: "https://cards.scryfall.io/art_crop/front/7/c/7c024bae-5631-4e20-ac69-df392ac9e109.jpg" },
  { oracleId: "up-the-beanstalk", nameJa: "豆の木をのぼれ", nameEn: "Up the Beanstalk", artCropUrl: "https://cards.scryfall.io/art_crop/front/2/d/2d5e991f-23b2-4db0-a452-7755125b1fd2.jpg" },
  { oracleId: "sunfall", nameJa: "太陽降下", nameEn: "Sunfall", artCropUrl: "https://cards.scryfall.io/art_crop/front/3/2/32e29c7d-ed4b-4eff-b3c2-d99e5b63ef8d.jpg" },
  { oracleId: "sheoldred", nameJa: "黙示録、シェオルドレッド", nameEn: "Sheoldred, the Apocalypse", artCropUrl: "https://cards.scryfall.io/art_crop/front/d/6/d67be074-cdd4-41d9-ac89-0a0456c4e4b2.jpg" },
  { oracleId: "fable-of-the-mirror-breaker", nameJa: "鏡割りの寓話", nameEn: "Fable of the Mirror-Breaker", artCropUrl: "https://cards.scryfall.io/art_crop/front/2/4/24c0d87b-0049-4beb-b9cb-6f813b7aa7dc.jpg" },
  { oracleId: "this-town-aint-big-enough", nameJa: "この町は狭すぎる", nameEn: "This Town Ain't Big Enough", artCropUrl: "https://cards.scryfall.io/art_crop/front/b/b/bb206e27-da4d-4abe-9d8c-6d18c5f2f52a.jpg" },
  { oracleId: "force-of-will", nameJa: "意志の力", nameEn: "Force of Will", artCropUrl: "https://cards.scryfall.io/art_crop/front/8/9/89f612d6-7c59-4a7b-a87d-45f789e88ba5.jpg" },
];

export function searchSampleCards(query: string): SearchIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!meetsMinQueryLength(q)) return [];
  return SAMPLE_SEARCH_INDEX.filter(
    (entry) =>
      entry.nameJa.toLowerCase().includes(q) || entry.nameEn.toLowerCase().includes(q),
  );
}
