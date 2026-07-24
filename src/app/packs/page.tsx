import PackEvCalculator from "@/components/PackEvCalculator";
import { SAMPLE_SETS, COLLECTOR_SAMPLE_SETS } from "@/lib/samplePackData";

export const metadata = { title: "パックEV計算 - MTG DataLab" };

export default function PackEvPage() {
  const playSets = SAMPLE_SETS;
  const collectorSets = COLLECTOR_SAMPLE_SETS;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">パックEV計算</h1>
      <p className="text-sm text-neutral-500">Play Booster / Collector Boosterに対応</p>
      <PackEvCalculator playSets={playSets} collectorSets={collectorSets} />
    </div>
  );
}
