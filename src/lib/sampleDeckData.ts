import type { Format } from "./formats";

/** TODO: archetypes / archetype_price_stats（db/schema.sql）から取得したデータに差し替える */
export interface ArchetypeRow {
  archetypeId: string;
  nameJa: string;
  nameEn: string;
  medianPriceJpy: number;
  usageRatePct: number;
  sampleSize: number;
  /**
   * 代表カードのアートクロップ画像URL（1枚）。通常フォーマットは最も採用率の高い非土地カード1枚。
   * Commanderでパートナー統率者（2枚）の場合はrepresentativeArtUrlsの方に2枚とも入る。
   */
  representativeArtUrl?: string | null;
  /** Commanderのパートナー統率者用（2枚）。無ければrepresentativeArtUrlのみ使う */
  representativeArtUrls?: string[];
  /** そのアーキタイプの色（WUBRG順）。デッキ全体の採用枚数から推定した色identity */
  colors?: string[];
}

const SAMPLE_ARCHETYPES: Record<string, ArchetypeRow[]> = {
  Standard: [
    { archetypeId: "std-domain-ramp", nameJa: "ドメイン・ランプ", nameEn: "Domain Ramp", medianPriceJpy: 28400, usageRatePct: 18.2, sampleSize: 20 },
    { archetypeId: "std-mono-red-aggro", nameJa: "赤単アグロ", nameEn: "Mono Red Aggro", medianPriceJpy: 9600, usageRatePct: 15.7, sampleSize: 20 },
    { archetypeId: "std-esper-control", nameJa: "エスパーコントロール", nameEn: "Esper Control", medianPriceJpy: 34200, usageRatePct: 11.4, sampleSize: 18 },
  ],
  Modern: [
    { archetypeId: "mod-rakdos-scam", nameJa: "ラクドス・スキャム", nameEn: "Rakdos Scam", medianPriceJpy: 61800, usageRatePct: 14.9, sampleSize: 20 },
    { archetypeId: "mod-murktide-regent", nameJa: "マークタイド", nameEn: "Murktide Regent", medianPriceJpy: 78300, usageRatePct: 12.1, sampleSize: 20 },
    { archetypeId: "mod-living-end", nameJa: "リビングエンド", nameEn: "Living End", medianPriceJpy: 19500, usageRatePct: 9.8, sampleSize: 20 },
  ],
  Commander: [
    { archetypeId: "cmd-atraxa", nameJa: "偉大なる統一者、アトラクサ", nameEn: "Atraxa, Grand Unifier", medianPriceJpy: 142000, usageRatePct: 8.6, sampleSize: 20 },
    { archetypeId: "cmd-tymna-thrasios", nameJa: "ティムナ＆スラシオス", nameEn: "Tymna / Thrasios", medianPriceJpy: 216000, usageRatePct: 6.3, sampleSize: 15 },
  ],
  Vintage: [
    { archetypeId: "vin-doomsday", nameJa: "ドゥームズデイ", nameEn: "Doomsday", medianPriceJpy: 890000, usageRatePct: 7.2, sampleSize: 8 },
    { archetypeId: "vin-paradoxical-outcome", nameJa: "パラドックス・アウトカム", nameEn: "Paradoxical Outcome", medianPriceJpy: 654000, usageRatePct: 5.4, sampleSize: 6 },
  ],
};

export function getSampleArchetypes(format: Format): ArchetypeRow[] {
  return SAMPLE_ARCHETYPES[format] ?? [];
}
