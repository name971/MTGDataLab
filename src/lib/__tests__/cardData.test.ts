import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from "@/lib/supabase";
import { getCardDetailFromDb, getLatestPriceSnapshot } from "@/lib/cardData";

function mockOracleThenCards(oracleResult: unknown, cardsResult: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue(oracleResult);
  const ilike = vi.fn().mockReturnValue({ maybeSingle });
  const oracleSelect = vi.fn().mockReturnValue({ ilike });

  const eq = vi.fn().mockResolvedValue(cardsResult);
  const cardsSelect = vi.fn().mockReturnValue({ eq });

  // resolveFallbackTypeLineJa/resolveFallbackTextJaがDBだけで完結するようになったため、
  // 追加で"cards"テーブルに別チェーン（.eq().eq().not().limit().maybeSingle()）で
  // 問い合わせる。テストではフォールバック先が見つからない（null）ケースとして扱う。
  const fallbackMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const fallbackLimit = vi.fn().mockReturnValue({ maybeSingle: fallbackMaybeSingle });
  const fallbackNot = vi.fn().mockReturnValue({ limit: fallbackLimit });
  const fallbackEq2 = vi.fn().mockReturnValue({ not: fallbackNot });
  const fallbackEq1 = vi.fn().mockReturnValue({ eq: fallbackEq2 });
  const fallbackSelect = vi.fn().mockReturnValue({ eq: fallbackEq1 });

  let cardsCallCount = 0;
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "card_oracles") return { select: oracleSelect };
    if (table === "cards") {
      cardsCallCount += 1;
      return { select: cardsCallCount === 1 ? cardsSelect : fallbackSelect };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe("getCardDetailFromDb", () => {
  it("returns the en/ja cards split out when both exist", async () => {
    mockOracleThenCards(
      { data: { oracle_id: "oid-1", name: "Solitude", printed_name_ja: "孤独" }, error: null },
      {
        data: [
          { scryfall_id: "en-1", oracle_id: "oid-1", lang: "en", name: "Solitude" },
          { scryfall_id: "ja-1", oracle_id: "oid-1", lang: "ja", name: "Solitude" },
        ],
        error: null,
      },
    );

    const result = await getCardDetailFromDb("Solitude");
    expect(result?.enCard.scryfall_id).toBe("en-1");
    expect(result?.jaCard?.scryfall_id).toBe("ja-1");
  });

  it("returns jaCard null when only the English printing is stored", async () => {
    mockOracleThenCards(
      { data: { oracle_id: "oid-2", name: "Ragavan, Nimble Pilferer", printed_name_ja: null }, error: null },
      {
        data: [{ scryfall_id: "en-2", oracle_id: "oid-2", lang: "en", name: "Ragavan, Nimble Pilferer" }],
        error: null,
      },
    );

    const result = await getCardDetailFromDb("Ragavan, Nimble Pilferer");
    expect(result?.jaCard).toBeNull();
  });

  it("returns null when the oracle isn't found (not yet imported)", async () => {
    mockOracleThenCards({ data: null, error: null }, { data: [], error: null });
    const result = await getCardDetailFromDb("Some Unimported Card");
    expect(result).toBeNull();
  });

  it("returns null when the oracle lookup errors", async () => {
    mockOracleThenCards({ data: null, error: { message: "network error" } }, { data: [], error: null });
    const result = await getCardDetailFromDb("Solitude");
    expect(result).toBeNull();
  });
});

describe("getLatestPriceSnapshot", () => {
  function mockSnapshotChain(result: unknown) {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    const limit = vi.fn().mockReturnValue({ maybeSingle });
    const order = vi.fn().mockReturnValue({ limit });
    const eq2 = vi.fn().mockReturnValue({ order });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });
  }

  it("returns the snapshot's usd and jpy_est when found", async () => {
    mockSnapshotChain({ data: { usd: 43.84, jpy_est: 7096.38 }, error: null });
    const result = await getLatestPriceSnapshot("oid-1", "en");
    expect(result).toEqual({ usd: 43.84, jpyEst: 7096.38 });
  });

  it("returns null when no snapshot exists yet", async () => {
    mockSnapshotChain({ data: null, error: null });
    const result = await getLatestPriceSnapshot("oid-1", "en");
    expect(result).toBeNull();
  });
});
