import { Suspense } from "react";
import { getMlRankingFromDb } from "@/lib/dbMlRanking";
import MlRankingList from "@/components/MlRankingList";
import InfoTooltip from "@/components/InfoTooltip";
import MaintenanceBanner from "@/components/MaintenanceBanner";
import { isLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { getDictionary } from "@/i18n/getDictionary";

// 集計バッチは1日1回しか回らないため、鮮度より egress 削減を優先して長めにキャッシュする（ISR）
export const revalidate = 3600;

export default async function TopPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const t = getDictionary(locale).home;
  // DB接続そのものが失敗した場合はメンテナンス中であることを表示する
  // （2026-08-17、DB障害中もサイトが正常に見えてしまっていたインシデントの再発防止）。
  let mlRankingUp: Awaited<ReturnType<typeof getMlRankingFromDb>> = [];
  let mlRankingDown: Awaited<ReturnType<typeof getMlRankingFromDb>> = [];
  let dbDown = false;
  try {
    [mlRankingUp, mlRankingDown] = await Promise.all([
      getMlRankingFromDb("up", locale),
      getMlRankingFromDb("down", locale),
    ]);
  } catch (err) {
    // 原因調査に使えるよう、握りつぶさずCloudflareのログに残す（2026-08-29、
    // DB接続失敗の実際の原因が分からず調査が難航したため）
    console.error("TopPage: DB接続失敗", err);
    dbDown = true;
  }

  return (
    <div className="flex flex-col gap-16">
      {dbDown && <MaintenanceBanner />}

      {(mlRankingUp.length > 0 || mlRankingDown.length > 0) && (
        <section>
          <h2 className="mb-5 flex items-center gap-1.5 text-2xl font-bold tracking-tight text-neutral-900">
            {t.mlRankingHeading}
            <InfoTooltip text={t.mlRankingInfo} />
          </h2>
          <Suspense fallback={null}>
            <MlRankingList up={mlRankingUp} down={mlRankingDown} />
          </Suspense>
        </section>
      )}
    </div>
  );
}
