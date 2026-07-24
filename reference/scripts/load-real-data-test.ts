import { readdirSync, readFileSync } from "fs";
import { classifyDeck } from "./archetype-engine.ts";
import type { ArchetypeDefinition, FallbackDefinition, FormatData } from "./archetype-engine.ts";

const BASE = "./MTGOFormatData-main/Formats/Modern";
const archetypeFiles = readdirSync(`${BASE}/Archetypes`).filter(f => f.endsWith(".json"));
const archetypes: ArchetypeDefinition[] = archetypeFiles.map(f => {
  const raw = JSON.parse(readFileSync(`${BASE}/Archetypes/${f}`, "utf-8"));
  return { Name: raw.Name, Conditions: raw.Conditions, Variants: raw.Variants };
});
const fallbackFiles = readdirSync(`${BASE}/Fallbacks`).filter(f => f.endsWith(".json"));
const fallbacks: FallbackDefinition[] = fallbackFiles.map(f => {
  const raw = JSON.parse(readFileSync(`${BASE}/Fallbacks/${f}`, "utf-8"));
  return { Name: raw.Name, CommonCards: raw.CommonCards };
});
const formatData: FormatData = { format: "Modern", archetypes, fallbacks, fallbackMinOverlap: 3 };

// 実際のScam定義の条件を満たすデッキ
const scamDeck = {
  mainboard: [
    { name: "Grief", count: 4 },
    { name: "Undying Evil", count: 2 },
    { name: "Fatal Push", count: 4 },
  ],
  sideboard: [],
};

// 実際のLivingEnd定義の条件を満たすデッキ
const livingEndDeck = {
  mainboard: [
    { name: "Living End", count: 4 },
    { name: "Street Wraith", count: 4 },
  ],
  sideboard: [],
};

// Ragavanを混ぜるとScamの除外条件に引っかかるはず
const scamButWithRagavan = {
  mainboard: [
    { name: "Grief", count: 4 },
    { name: "Undying Evil", count: 2 },
    { name: "Ragavan, Nimble Pilferer", count: 4 },
  ],
  sideboard: [],
};

console.log("Scamデッキ:", classifyDeck(scamDeck, formatData).archetype);
console.log("LivingEndデッキ:", classifyDeck(livingEndDeck, formatData).archetype);
console.log("Scam+Ragavan(除外条件のテスト):", classifyDeck(scamButWithRagavan, formatData));
