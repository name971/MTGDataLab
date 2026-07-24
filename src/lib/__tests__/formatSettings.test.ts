import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from "@/lib/supabase";
import { getFormatSettings } from "@/lib/formatSettings";

function mockSupabaseResponse(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select });
}

describe("getFormatSettings", () => {
  it("returns the row's period days and caveat note when Supabase has data", async () => {
    mockSupabaseResponse({ default_period_days: 30, caveat_note: "母数が少ないので注意" });
    const result = await getFormatSettings("Commander");
    expect(result).toEqual({ periodDays: 30, caveatNote: "母数が少ないので注意" });
  });

  it("falls back to the hardcoded default when no row is found", async () => {
    mockSupabaseResponse(null, null);
    const result = await getFormatSettings("Standard");
    expect(result).toEqual({ periodDays: 14, caveatNote: null });
  });

  it("falls back to the hardcoded default when Supabase returns an error", async () => {
    mockSupabaseResponse(null, { message: "network error" });
    const result = await getFormatSettings("Modern");
    expect(result).toEqual({ periodDays: 30, caveatNote: null });
  });
});
