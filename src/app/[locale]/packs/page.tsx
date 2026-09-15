import PackEvCalculator from "@/components/PackEvCalculator";
import { getPackSetsFromDb, getSetReleaseDates } from "@/lib/dbPackEv";
import { SAMPLE_SETS, COLLECTOR_SAMPLE_SETS } from "@/lib/samplePackData";
import { supabase } from "@/lib/supabase";
import { isLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  return { title: getDictionary(locale).packEv.metaTitle };
}

// revalidate未設定だとビルド時の1回だけ静的生成されて以降ずっとキャッシュされ続けてしまう
// （match_rate等の日次更新が反映されない不具合の原因だった）。集計バッチは1日1回のみのため、
// 他のページと同様に長めのキャッシュで十分。
export const revalidate = 21600;

export default async function PackEvPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).packEv;
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
      <h1 className="text-xl font-semibold">{t.heading}</h1>
      <p className="text-sm text-neutral-500">{t.subheading}</p>
      <PackEvCalculator playSets={playSets} collectorSets={collectorSets} />
    </div>
  );
}
