export const COLOR_ORDER = ["W", "U", "B", "R", "G"] as const;

/** "{2}{W/U}{B}"のようなmana_costからW/U/B/R/Gの色を（WUBRG順で）抽出する */
export function colorsFromManaCost(manaCost: string | null | undefined): string[] {
  if (!manaCost) return [];
  const present = new Set(
    [...manaCost.matchAll(/\{([^}]+)\}/g)].flatMap((m) => m[1].split("/")),
  );
  return COLOR_ORDER.filter((c) => present.has(c));
}

/**
 * "{2}{W/U}{B}"のようなmana_costからマナ総量（CMC）を概算する。DBにcmc列を持たない
 * ため、mana_costのシンボルを数え上げて求める（マナカーブ表示用、デッキ統計バーで使用）。
 * X/Y/Zは0扱い、色マナ・ハイブリッド・Phyrexianマナ等は1として数える。
 */
export function cmcFromManaCost(manaCost: string | null | undefined): number {
  if (!manaCost) return 0;
  let total = 0;
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const symbol = m[1];
    if (/^\d+$/.test(symbol)) {
      total += Number(symbol);
    } else if (symbol === "X" || symbol === "Y" || symbol === "Z") {
      total += 0;
    } else {
      total += 1;
    }
  }
  return total;
}
