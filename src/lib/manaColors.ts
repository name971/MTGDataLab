export const COLOR_ORDER = ["W", "U", "B", "R", "G"] as const;

/** "{2}{W/U}{B}"のようなmana_costからW/U/B/R/Gの色を（WUBRG順で）抽出する */
export function colorsFromManaCost(manaCost: string | null | undefined): string[] {
  if (!manaCost) return [];
  const present = new Set(
    [...manaCost.matchAll(/\{([^}]+)\}/g)].flatMap((m) => m[1].split("/")),
  );
  return COLOR_ORDER.filter((c) => present.has(c));
}
