import PackEvCalculator from "@/components/PackEvCalculator";
import { getPackSetsFromDb, getSetReleaseDates } from "@/lib/dbPackEv";
import { SAMPLE_SETS, COLLECTOR_SAMPLE_SETS } from "@/lib/samplePackData";
import { supabase } from "@/lib/supabase";

export const metadata = { title: "パックEV計算 - MTG DataLab" };

export default async function PackEvPage() {
  // 発売日はplay/collectorで同じセットが重なるため、先に対象セット一覧をまとめて取ってから
  // 1回だけ取得する（getPackSetsFromDb内で毎回取り直すと往復が倍になる）。
  const { data: slotDefRows } = await supabase.from("pack_slot_definitions").select("set_code");
  const allSetCodes = [...new Set((slotDefRows ?? []).map((r) => r.set_code))];
  const releasedAtBySet = await getSetReleaseDates(allSetCodes);

  const [dbPlaySets, dbCollectorSets] = await Promise.all([
    getPackSetsFromDb("play_booster", releasedAtBySet),
    getPackSetsFromDb("collector_booster", releasedAtBySet),
  ]);
  // DBに実データが無い場合（初回集計前など）は静的サンプルにフォールバックする
  const playSets = dbPlaySets.length > 0 ? dbPlaySets : SAMPLE_SETS;
  const collectorSets = dbCollectorSets.length > 0 ? dbCollectorSets : COLLECTOR_SAMPLE_SETS;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">パックEV計算</h1>
      <p className="text-sm text-neutral-500">Play Booster / Collector Boosterに対応</p>
      <PackEvCalculator playSets={playSets} collectorSets={collectorSets} />
    </div>
  );
}
