/** pack_slot_definitions（db/schema.sql）に差し替え済みのセットは実データ、それ以外は
 * このファイルのslotsがフォールバックとして使われる（src/app/packs/page.tsx参照）。
 * scripts/generate-pack-data.mjsで自動生成（MTGJSON booster.play.sheets + Scryfall平均価格）。
 * 再生成: NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... node scripts/generate-pack-data.mjs
 */

export type Rarity = "common" | "uncommon" | "rare" | "mythic";

export interface PackSlot {
  slotName: string;
  cardCount: number;
  probabilityByRarity: Partial<Record<Rarity, number>>;
  /** そのスロット1枚あたりの期待価格（円）。スロットのfoilフラグに応じてusd/usd_foilを
   * 使い分けて算出済みなので、フォイル確定スロットのプレミアムやshowcase等特殊枠の実売価格
   * （scryfallIdの印刷単位で価格を引くため自然と反映される）も反映されている。 */
  avgPriceJpy: number;
  /** このスロットの排出カード（MTGJSONのuuid）のうち、実際のカードデータ（レアリティ・
   * 価格）まで解決できた割合。関連セット（統率者デッキ等）が未知の場合や、Scryfall側に
   * 該当印刷が無い場合に1.0未満になる。低いほどavgPriceJpy/probabilityByRarityの
   * 信頼度が下がる。 */
  matchRate: number;
}

export interface SampleSet {
  setCode: string;
  setName: string;
  releasedAt: string;
  packPriceJpy: number;
  packImageUrl: string | null;
  slots: PackSlot[];
}

/** 各スロットの「枚数 × スロット単価」を全スロットで合算する */
export function calculatePackEv(set: SampleSet): number {
  return set.slots.reduce((total, slot) => total + slot.cardCount * slot.avgPriceJpy, 0);
}

export const SAMPLE_SETS: SampleSet[] = [
  {
    "setCode": "msh",
    "setName": "Marvel Super Heroes",
    "releasedAt": "2026-06-26",
    "packPriceJpy": 873,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/675602_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 22,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.608,
          "rare": 0.07106896551724137,
          "uncommon": 0.308,
          "mythic": 0.01293103448275862
        },
        "avgPriceJpy": 97,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8275862068965517,
          "mythic": 0.1724137931034483
        },
        "avgPriceJpy": 420,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.13,
          "rare": 0.182,
          "uncommon": 0.667,
          "mythic": 0.021
        },
        "avgPriceJpy": 93,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "sos",
    "setName": "Secrets of Strixhaven",
    "releasedAt": "2026-04-24",
    "packPriceJpy": 777,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/675554_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 6,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 23,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.36383902764396353,
          "mythic": 0.013503467406380028,
          "common": 0.5441221374045802,
          "rare": 0.07853536754507628
        },
        "avgPriceJpy": 67,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 2,
        "probabilityByRarity": {
          "mythic": 0.02912621359223301,
          "uncommon": 0.8737864077669902,
          "rare": 0.0970873786407767
        },
        "avgPriceJpy": 121,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.14285714285714285,
          "rare": 0.8571428571428571
        },
        "avgPriceJpy": 222,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 40,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tmt",
    "setName": "Teenage Mutant Ninja Turtles",
    "releasedAt": "2026-03-06",
    "packPriceJpy": 647,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/657848_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 21,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.619,
          "uncommon": 0.283,
          "mythic": 0.012148760330578512,
          "rare": 0.08585123966942149
        },
        "avgPriceJpy": 68,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 2,
        "probabilityByRarity": {
          "mythic": 0.039,
          "uncommon": 0.196,
          "rare": 0.078,
          "common": 0.687
        },
        "avgPriceJpy": 60.5,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8990825688073395,
          "mythic": 0.10091743119266056
        },
        "avgPriceJpy": 247,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 2,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "ecl",
    "setName": "Lorwyn Eclipsed",
    "releasedAt": "2026-01-23",
    "packPriceJpy": 801,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/656311_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 25,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.30657142857142855,
          "rare": 0.07528571428571429,
          "mythic": 0.014142857142857143,
          "common": 0.604
        },
        "avgPriceJpy": 82,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8479400895856662,
          "mythic": 0.1520599104143337
        },
        "avgPriceJpy": 347,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 41,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.5916883116883117,
          "rare": 0.20402597402597403,
          "mythic": 0.024285714285714285,
          "common": 0.18
        },
        "avgPriceJpy": 104,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tla",
    "setName": "Avatar: The Last Airbender",
    "releasedAt": "2025-11-21",
    "packPriceJpy": 811,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/648640_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 24,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.37055233497101475,
          "rare": 0.07526210593038195,
          "common": 0.5406218655967904,
          "mythic": 0.013563693501812945
        },
        "avgPriceJpy": 92,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8503951367781155,
          "mythic": 0.1496048632218845
        },
        "avgPriceJpy": 403,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.7458813559322034,
          "rare": 0.1800726392251816,
          "common": 0.042,
          "mythic": 0.032046004842615015
        },
        "avgPriceJpy": 115,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "spm",
    "setName": "Marvel's Spider-Man",
    "releasedAt": "2025-09-26",
    "packPriceJpy": 790,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/621106_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 24,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.08527128997484729,
          "common": 0.658,
          "uncommon": 0.2441304347826087,
          "mythic": 0.012598275242544017
        },
        "avgPriceJpy": 88,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8736178901312591,
          "mythic": 0.12638210986874088
        },
        "avgPriceJpy": 426,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 38,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.2164089112468559,
          "common": 0.708,
          "uncommon": 0.04439130434782609,
          "mythic": 0.031199784405318003
        },
        "avgPriceJpy": 124,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "eoe",
    "setName": "Edge of Eternities",
    "releasedAt": "2025-08-01",
    "packPriceJpy": 1035,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/619697_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 24,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.0840875912408759,
          "uncommon": 0.31996800319968005,
          "common": 0.57994200579942,
          "mythic": 0.016002399760024
        },
        "avgPriceJpy": 108,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8439474285714286,
          "mythic": 0.15605257142857143
        },
        "avgPriceJpy": 450,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 36,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.2180752380952381,
          "uncommon": 0.625,
          "common": 0.125,
          "mythic": 0.03192476190476191
        },
        "avgPriceJpy": 184,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "fin",
    "setName": "Final Fantasy",
    "releasedAt": "2025-06-13",
    "packPriceJpy": 1409,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/618889_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 30,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.5585,
          "mythic": 0.01,
          "rare": 0.065,
          "uncommon": 0.3665
        },
        "avgPriceJpy": 124,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.115,
          "rare": 0.885
        },
        "avgPriceJpy": 546,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 48,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.193,
          "mythic": 0.019205,
          "rare": 0.147795,
          "uncommon": 0.64
        },
        "avgPriceJpy": 132,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tdm",
    "setName": "Tarkir: Dragonstorm",
    "releasedAt": "2025-04-11",
    "packPriceJpy": 850,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/619644_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 26,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.33043478260869563,
          "rare": 0.07843064182194617,
          "common": 0.5775217391304348,
          "mythic": 0.013612836438923396
        },
        "avgPriceJpy": 84,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8537414965986394,
          "mythic": 0.14625850340136054
        },
        "avgPriceJpy": 400,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 37,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.6116956521739131,
          "rare": 0.1948985507246377,
          "common": 0.15943478260869565,
          "mythic": 0.03397101449275362
        },
        "avgPriceJpy": 121,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "dft",
    "setName": "Aetherdrift",
    "releasedAt": "2025-02-14",
    "packPriceJpy": 736,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/604249_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 25,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.012142857142857143,
          "uncommon": 0.305,
          "rare": 0.07285714285714286,
          "common": 0.61
        },
        "avgPriceJpy": 72,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.14285714285714285,
          "rare": 0.8571428571428571
        },
        "avgPriceJpy": 326,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 37,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.029714285714285714,
          "uncommon": 0.667,
          "rare": 0.1782857142857143,
          "common": 0.125
        },
        "avgPriceJpy": 96,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "fdn",
    "setName": "Foundations",
    "releasedAt": "2024-11-15",
    "packPriceJpy": 873,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/562116_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.6,
          "uncommon": 0.25,
          "rare": 0.12857142857142856,
          "mythic": 0.02142857142857143
        },
        "avgPriceJpy": 132,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8571428571428571,
          "mythic": 0.14285714285714285
        },
        "avgPriceJpy": 418,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 49,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.185,
          "uncommon": 0.607,
          "rare": 0.1782857142857143,
          "mythic": 0.029714285714285714
        },
        "avgPriceJpy": 124,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "dsk",
    "setName": "Duskmourn: House of Horror",
    "releasedAt": "2024-09-27",
    "packPriceJpy": 970,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/557240_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 23,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.6,
          "uncommon": 0.25,
          "mythic": 0.02142857142857143,
          "rare": 0.12857142857142856
        },
        "avgPriceJpy": 133,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "mythic": 0.14285714285714285,
          "rare": 0.8571428571428571
        },
        "avgPriceJpy": 464,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 58,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.7,
          "uncommon": 0.175,
          "mythic": 0.017857142857142856,
          "rare": 0.10714285714285714
        },
        "avgPriceJpy": 85,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "blb",
    "setName": "Bloomburrow",
    "releasedAt": "2024-08-02",
    "packPriceJpy": 1107,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/541234_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 27,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.6,
          "rare": 0.12857142857142856,
          "mythic": 0.02142857142857143,
          "uncommon": 0.25
        },
        "avgPriceJpy": 148,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8571428571428571,
          "mythic": 0.14285714285714285
        },
        "avgPriceJpy": 472,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 55,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.7,
          "rare": 0.10714285714285714,
          "mythic": 0.017857142857142856,
          "uncommon": 0.175
        },
        "avgPriceJpy": 88,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "otj",
    "setName": "Outlaws of Thunder Junction",
    "releasedAt": "2024-04-19",
    "packPriceJpy": 940,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/541083_200w.jpg",
    "slots": [
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 2,
        "probabilityByRarity": {
          "mythic": 0.1111111111111111,
          "uncommon": 0.6666666666666666,
          "rare": 0.2222222222222222
        },
        "avgPriceJpy": 124.5,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 6,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 24,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.25,
          "rare": 0.12857142857142856,
          "common": 0.6,
          "mythic": 0.02142857142857143
        },
        "avgPriceJpy": 91,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8571428571428571,
          "mythic": 0.14285714285714285
        },
        "avgPriceJpy": 313,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 43,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "mkm",
    "setName": "Murders at Karlov Manor",
    "releasedAt": "2024-02-09",
    "packPriceJpy": 806,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/529962_200w.jpg",
    "slots": [
      {
        "slotName": "確定コモン",
        "cardCount": 7,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 24,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.13125,
          "common": 0.6,
          "uncommon": 0.25,
          "mythic": 0.01875
        },
        "avgPriceJpy": 119,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.8571428571428571,
          "mythic": 0.14285714285714285
        },
        "avgPriceJpy": 168,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 31,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.25595238095238093,
          "common": 0.5833333333333334,
          "uncommon": 0.14583333333333334,
          "mythic": 0.01488095238095238
        },
        "avgPriceJpy": 340,
        "matchRate": 1
      }
    ]
  }
];

export const COLLECTOR_SAMPLE_SETS: SampleSet[] = [
  {
    "setCode": "msh",
    "setName": "Marvel Super Heroes",
    "releasedAt": "2026-06-26",
    "packPriceJpy": 6812,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/675605_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8108461538461539,
          "mythic": 0.18915384615384614
        },
        "avgPriceJpy": 1210.2,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.2,
          "uncommon": 0.8
        },
        "avgPriceJpy": 53,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 42.2,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 141.33333333333334,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "sos",
    "setName": "Secrets of Strixhaven",
    "releasedAt": "2026-04-24",
    "packPriceJpy": 7555,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/675557_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8571428571428571,
          "mythic": 0.14285714285714285
        },
        "avgPriceJpy": 485,
        "matchRate": 0.9968509186351706
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 58.6,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tmt",
    "setName": "Teenage Mutant Ninja Turtles",
    "releasedAt": "2026-03-06",
    "packPriceJpy": 6718,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/657851_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.20046231468515927,
          "rare": 0.7995376853148407
        },
        "avgPriceJpy": 629.4,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 37,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 51,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "ecl",
    "setName": "Lorwyn Eclipsed",
    "releasedAt": "2026-01-23",
    "packPriceJpy": 6178,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/656318_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.7595988625493956,
          "mythic": 0.24040113745060443
        },
        "avgPriceJpy": 503.8,
        "matchRate": 0.9790732552326549
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 34,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 55,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tla",
    "setName": "Avatar: The Last Airbender",
    "releasedAt": "2025-11-21",
    "packPriceJpy": 6705,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/648646_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8479439704605267,
          "mythic": 0.15205602953947325
        },
        "avgPriceJpy": 988.6,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 62.8,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 131.75,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "spm",
    "setName": "Marvel's Spider-Man",
    "releasedAt": "2025-09-26",
    "packPriceJpy": 5378,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/621109_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.850130204933307,
          "mythic": 0.14986979506669293
        },
        "avgPriceJpy": 728.6,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 39,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 67,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "eoe",
    "setName": "Edge of Eternities",
    "releasedAt": "2025-08-01",
    "packPriceJpy": 10516,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/619696_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 4,
        "probabilityByRarity": {
          "rare": 0.9090909090909091,
          "mythic": 0.09090909090909091
        },
        "avgPriceJpy": 880.75,
        "matchRate": 0.9848790322580645
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 36,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 48,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "fin",
    "setName": "Final Fantasy",
    "releasedAt": "2025-06-13",
    "packPriceJpy": 24701,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/618892_200w.jpg",
    "slots": [
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 120.25,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.8625,
          "common": 0.1375
        },
        "avgPriceJpy": 182,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.14914180969838362,
          "rare": 0.8508581903016164
        },
        "avgPriceJpy": 1611.6,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 42,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "rare": 0.257,
          "uncommon": 0.683,
          "mythic": 0.06
        },
        "avgPriceJpy": 665,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "tdm",
    "setName": "Tarkir: Dragonstorm",
    "releasedAt": "2025-04-11",
    "packPriceJpy": 6800,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/619648_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.142,
          "rare": 0.858
        },
        "avgPriceJpy": 667.8,
        "matchRate": 0.986002799440112
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 34,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.454,
          "common": 0.546
        },
        "avgPriceJpy": 53,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 50,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.454,
          "common": 0.546
        },
        "avgPriceJpy": 47,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "dft",
    "setName": "Aetherdrift",
    "releasedAt": "2025-02-14",
    "packPriceJpy": 4100,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/604252_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8695652173913043,
          "mythic": 0.13043478260869565
        },
        "avgPriceJpy": 371.8,
        "matchRate": 0.9916016796640672
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 37,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.46875,
          "uncommon": 0.53125
        },
        "avgPriceJpy": 35,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 52,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "common": 0.46875,
          "uncommon": 0.53125
        },
        "avgPriceJpy": 28,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "fdn",
    "setName": "Foundations",
    "releasedAt": "2024-11-15",
    "packPriceJpy": 13305,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/562121_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.2328042328042328,
          "rare": 0.7671957671957672
        },
        "avgPriceJpy": 1204.4,
        "matchRate": 0.9890000000000001
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 51,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 92,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "dsk",
    "setName": "Duskmourn: House of Horror",
    "releasedAt": "2024-09-27",
    "packPriceJpy": 9479,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/557243_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.14492753623188406,
          "rare": 0.855072463768116
        },
        "avgPriceJpy": 790,
        "matchRate": 0.9937999999999999
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 41,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 75,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "blb",
    "setName": "Bloomburrow",
    "releasedAt": "2024-08-02",
    "packPriceJpy": 15470,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/541237_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.15942028985507245,
          "rare": 0.8405797101449275
        },
        "avgPriceJpy": 1174.8,
        "matchRate": 0.9938650306748466
      },
      {
        "slotName": "確定コモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 39,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 79,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "otj",
    "setName": "Outlaws of Thunder Junction",
    "releasedAt": "2024-04-19",
    "packPriceJpy": 7261,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/541086_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.1111111111111111,
          "rare": 0.8888888888888888
        },
        "avgPriceJpy": 758.4,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 34,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 48.4,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "mkm",
    "setName": "Murders at Karlov Manor",
    "releasedAt": "2024-02-09",
    "packPriceJpy": 4949,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/529967_200w.jpg",
    "slots": [
      {
        "slotName": "ワイルドカード（非フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.47619047619047616,
          "common": 0.5238095238095238
        },
        "avgPriceJpy": 29,
        "matchRate": 1
      },
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "mythic": 0.09302325581395349,
          "rare": 0.9069767441860465
        },
        "avgPriceJpy": 658.4,
        "matchRate": 0.9892972972972973
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 25,
        "matchRate": 1
      },
      {
        "slotName": "ワイルドカード（フォイル）",
        "cardCount": 1,
        "probabilityByRarity": {
          "uncommon": 0.47619047619047616,
          "common": 0.5238095238095238
        },
        "avgPriceJpy": 46,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 3,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 42,
        "matchRate": 1
      }
    ]
  },
  {
    "setCode": "lci",
    "setName": "The Lost Caverns of Ixalan",
    "releasedAt": "2023-11-17",
    "packPriceJpy": 14562,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/516613_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8837209302325582,
          "mythic": 0.11627906976744186
        },
        "avgPriceJpy": 587,
        "matchRate": 0.9754385964912281
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 39,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 69,
        "matchRate": 0.9946504992867332
      }
    ]
  },
  {
    "setCode": "woe",
    "setName": "Wilds of Eldraine",
    "releasedAt": "2023-09-08",
    "packPriceJpy": 14619,
    "packImageUrl": "https://tcgplayer-cdn.tcgplayer.com/product/496040_200w.jpg",
    "slots": [
      {
        "slotName": "レア/神話スロット",
        "cardCount": 5,
        "probabilityByRarity": {
          "rare": 0.8089737991266376,
          "mythic": 0.19102620087336245
        },
        "avgPriceJpy": 1077.6,
        "matchRate": 1
      },
      {
        "slotName": "確定アンコモン",
        "cardCount": 5,
        "probabilityByRarity": {
          "uncommon": 1
        },
        "avgPriceJpy": 81.4,
        "matchRate": 1
      },
      {
        "slotName": "確定コモン",
        "cardCount": 4,
        "probabilityByRarity": {
          "common": 1
        },
        "avgPriceJpy": 43,
        "matchRate": 1
      }
    ]
  }
];
