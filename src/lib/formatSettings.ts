import { supabase } from "./supabase";
import { defaultPeriodDays, type Format } from "./formats";

export interface FormatSettings {
  periodDays: number;
  caveatNote: string | null;
}

/**
 * format_settings（db/schema.sql）から実データを取得する。
 * DB未接続/該当行なしの場合はformats.tsのハードコード値にフォールバックする。
 */
export async function getFormatSettings(format: Format): Promise<FormatSettings> {
  const { data, error } = await supabase
    .from("format_settings")
    .select("default_period_days, caveat_note")
    .eq("format", format)
    .maybeSingle();

  if (error || !data) {
    return { periodDays: defaultPeriodDays(format), caveatNote: null };
  }

  return { periodDays: data.default_period_days, caveatNote: data.caveat_note };
}
