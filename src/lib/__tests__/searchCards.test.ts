import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

import { supabase } from "@/lib/supabase";
import { searchCardsInDb } from "@/lib/searchCards";

describe("searchCardsInDb", () => {
  it("returns an empty array without calling Supabase when the query is under 2 characters", async () => {
    const result = await searchCardsInDb("a");
    expect(result).toEqual([]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("joins the representative art_crop image onto each RPC result", async () => {
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ oracle_id: "oid-1", name: "Solitude", printed_name_ja: "孤独" }],
      error: null,
    });
    const inMock = vi.fn().mockResolvedValue({
      data: [
        { oracle_id: "oid-1", lang: "en", image_uri_art_crop: "https://example.com/en.jpg" },
        { oracle_id: "oid-1", lang: "ja", image_uri_art_crop: "https://example.com/ja.jpg" },
      ],
    });
    const selectMock = vi.fn().mockReturnValue({ in: inMock });
    (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });

    const result = await searchCardsInDb("solitude");
    expect(result).toEqual([
      {
        oracleId: "oid-1",
        nameEn: "Solitude",
        nameJa: "孤独",
        artCropUrl: "https://example.com/ja.jpg",
      },
    ]);
  });

  it("returns an empty array when the RPC call errors", async () => {
    (supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: "fail" } });
    const result = await searchCardsInDb("solitude");
    expect(result).toEqual([]);
  });
});
