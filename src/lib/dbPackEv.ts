import { supabase } from "./supabase";
import type { Rarity, PackSlot, SampleSet } from "./samplePackData";

const RANGE_PAGE_SIZE = 1000;

/**
 * 対象セットの発売日（最も早いプリントのreleased_at）をまとめて取得する。
 * 以前はセットごとに個別クエリを投げていたが（30セット近くで往復が多く遅かった上、
 * PostgRESTのデフォルト行数上限にも一度引っかかった）、ページングした一括クエリ1本+
 * クライアント側でのMIN計算に変更し、往復回数を減らす。
 * play/collector両方で同じセットコードが重複するため、呼び出し側で1回だけ呼んで
 * 両方のgetPackSetsFromDb呼び出しに使い回すことも想定している。
 */
export async function getSetReleaseDates(setCodes: string[]): Promise<Map<string, string>> {
  const releasedAtBySet = new Map<string, string>();
  if (setCodes.length === 0) return releasedAtBySet;

  for (let offset = 0; ; offset += RANGE_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("card_prints")
      .select("set_code, released_at")
      .in("set_code", setCodes)
      .not("released_at", "is", null)
      .range(offset, offset + RANGE_PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;

    for (const row of data) {
      const existing = releasedAtBySet.get(row.set_code);
      if (!existing || row.released_at < existing) releasedAtBySet.set(row.set_code, row.released_at);
    }
    if (data.length < RANGE_PAGE_SIZE) break;
  }
  return releasedAtBySet;
}

/**
 * db/schema.sqlのpack_slot_definitions（排出確率の内訳表示用、めったに変わらないため
 * 手動更新のまま）とpack_slot_avg_prices（スロット単位の期待価格、
 * scripts/compute-pack-slot-avg-prices.mjsが日次計算）を組み合わせて、
 * パックEVページ用のSampleSet[]をその場で組み立てる。
 * pack_slot_avg_prices自体はpack_slot_cards（MTGJSONブースターシートのカード単位ウェイト、
 * 静的）×card_print_prices（日次価格）の重み付き平均なので、元のsamplePackData.ts
 * （scripts/generate-pack-data.mjs）と同じ精度のまま日次で自動更新される。
 *
 * releasedAtBySetは呼び出し側でgetSetReleaseDates()を1回だけ呼んで使い回す想定
 * （play/collector両方で同じセットが重なるため、二重に取得しないようにする）。
 */
export async function getPackSetsFromDb(
  productType: "play_booster" | "collector_booster",
  releasedAtBySet: Map<string, string>,
): Promise<SampleSet[]> {
  const { data: slotRows, error } = await supabase
    .from("pack_slot_definitions")
    .select("set_code, slot_name, rarity, probability, card_count")
    .eq("product_type", productType);
  if (error || !slotRows || slotRows.length === 0) return [];

  const setCodes = [...new Set(slotRows.map((r) => r.set_code))];

  const [{ data: slotPriceRows }, { data: sealedPriceRows }, { data: productRows }, { data: setRows }] = await Promise.all([
    supabase
      .from("pack_slot_avg_prices")
      .select("set_code, slot_name, avg_price_jpy, match_rate, calculated_at")
      .eq("product_type", productType)
      .in("set_code", setCodes)
      .order("calculated_at", { ascending: false }),
    supabase
      .from("sealed_price_snapshots")
      .select("set_code, jpy_est, date")
      .eq("product_type", productType)
      .in("set_code", setCodes)
      .order("date", { ascending: false }),
    supabase.from("pack_products").select("set_code, pack_image_url").eq("product_type", productType).in("set_code", setCodes),
    supabase.from("sets").select("set_code, set_name").in("set_code", setCodes),
  ]);

  // 最新日のスロット単価だけを採用する
  const priceByKey = new Map<string, { avgPriceJpy: number; matchRate: number }>();
  for (const row of slotPriceRows ?? []) {
    const key = `${row.set_code}|${row.slot_name}`;
    if (!priceByKey.has(key)) {
      priceByKey.set(key, { avgPriceJpy: Number(row.avg_price_jpy), matchRate: Number(row.match_rate) });
    }
  }

  const packPriceBySet = new Map<string, number>();
  for (const row of sealedPriceRows ?? []) {
    if (!packPriceBySet.has(row.set_code) && row.jpy_est !== null) {
      packPriceBySet.set(row.set_code, Number(row.jpy_est));
    }
  }

  const imageBySet = new Map((productRows ?? []).map((r) => [r.set_code, r.pack_image_url]));
  const nameBySet = new Map((setRows ?? []).map((r) => [r.set_code, r.set_name]));

  // set_code -> slot_name -> レアリティ内訳[] にグルーピング（表示用）
  const slotsBySet = new Map<string, Map<string, { rarity: Rarity; probability: number; cardCount: number }[]>>();
  for (const row of slotRows) {
    if (!slotsBySet.has(row.set_code)) slotsBySet.set(row.set_code, new Map());
    const bySlotName = slotsBySet.get(row.set_code)!;
    if (!bySlotName.has(row.slot_name)) bySlotName.set(row.slot_name, []);
    bySlotName.get(row.slot_name)!.push({
      rarity: row.rarity as Rarity,
      probability: Number(row.probability),
      cardCount: row.card_count,
    });
  }

  const sets: SampleSet[] = [];
  for (const [setCode, bySlotName] of slotsBySet) {
    const packPriceJpy = packPriceBySet.get(setCode);
    if (packPriceJpy === undefined) continue; // パック単品の実勢価格が無ければEVを出しようがないので除外

    const slots: PackSlot[] = [];
    for (const [slotName, rarityRows] of bySlotName) {
      const price = priceByKey.get(`${setCode}|${slotName}`);
      if (!price) continue; // スロット単価が無ければそのスロットは出しようがない

      const probabilityByRarity: Partial<Record<Rarity, number>> = {};
      for (const r of rarityRows) probabilityByRarity[r.rarity] = r.probability;
      const cardCount = rarityRows[0]?.cardCount ?? 1;

      slots.push({
        slotName,
        cardCount,
        probabilityByRarity,
        avgPriceJpy: Math.round(price.avgPriceJpy),
        matchRate: price.matchRate,
      });
    }
    if (slots.length === 0) continue;

    sets.push({
      setCode,
      setName: nameBySet.get(setCode) ?? setCode,
      releasedAt: releasedAtBySet.get(setCode) ?? "",
      packPriceJpy: Math.round(packPriceJpy),
      packImageUrl: imageBySet.get(setCode) ?? null,
      slots,
    });
  }

  return sets;
}
