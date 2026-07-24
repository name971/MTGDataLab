import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from "@/lib/supabase";
import { getDeckDetailFromDb, getRecentDecksFromDb } from "@/lib/dbDeckDetail";

describe("getDeckDetailFromDb", () => {
  it("returns null when the deck isn't found", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });

    const result = await getDeckDetailFromDb(999);
    expect(result).toBeNull();
  });

  it("maps deck_cards to display cards, falling back to English name when unresolved", async () => {
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "decks") {
        const maybeSingle = vi.fn().mockResolvedValue({
          data: {
            id: 1,
            player_name: "Test Player",
            standing: "3-1",
            tournament_id: 5,
            tournaments: { event_name: "Test Cup", format: "Standard" },
          },
          error: null,
        });
        const eq = vi.fn().mockReturnValue({ maybeSingle });
        return { select: vi.fn().mockReturnValue({ eq }) };
      }
      if (table === "deck_cards") {
        const eq = vi.fn().mockResolvedValue({
          data: [
            { card_name: "Lightning Bolt", oracle_id: null, board: "main", quantity: 4 },
          ],
          error: null,
        });
        return { select: vi.fn().mockReturnValue({ eq }) };
      }
      if (table === "card_price_snapshots") {
        const order = vi.fn().mockResolvedValue({ data: [], error: null });
        const eq = vi.fn().mockReturnValue({ order });
        const inFn = vi.fn().mockReturnValue({ eq });
        return { select: vi.fn().mockReturnValue({ in: inFn }) };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const result = await getDeckDetailFromDb(1);
    expect(result?.playerName).toBe("Test Player");
    expect(result?.eventName).toBe("Test Cup");
    expect(result?.cards).toEqual([
      {
        oracleId: null,
        nameEn: "Lightning Bolt",
        nameJa: null,
        artCropUrl: null,
        imageNormalUrl: null,
        priceJpy: null,
        typeLine: null,
        manaCost: null,
        quantity: 4,
        board: "main",
      },
    ]);
  });
});

describe("getRecentDecksFromDb", () => {
  it("returns an empty array on error", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } });
    const order = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ order });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });

    const result = await getRecentDecksFromDb();
    expect(result).toEqual([]);
  });
});
