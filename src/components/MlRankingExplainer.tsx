import { getDictionary } from "@/i18n/getDictionary";
import type { Locale } from "@/i18n/config";

/**
 * 注目カードランキングの仕組み・精度を説明するホームページ用の補足セクション。
 * 数値（76%/84%・過去57週）はSNS等でのユーザーからの疑問を受けて2026-09-17に
 * 週次シミュレーションで実測した値で、home.mlRankingInfo（ツールチップ）とも揃えてある。
 * モデル・閾値・検証方法が変わったら両方更新すること。
 * page.tsxがサーバーコンポーネントのため、useLocale（クライアント専用）ではなく
 * localeをpropsで受け取る。
 */
export default function MlRankingExplainer({ locale }: { locale: Locale }) {
  const t = getDictionary(locale).home;

  const steps = [t.explainerStep1, t.explainerStep2, t.explainerStep3];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-neutral-200 bg-white p-6 sm:flex-row sm:justify-center sm:gap-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3 sm:gap-3">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-xs font-bold text-white">
                {i + 1}
              </span>
              <p className="max-w-[9rem] whitespace-pre-line text-sm font-medium text-neutral-800">{step}</p>
            </div>
            {i < steps.length - 1 && <span className="hidden text-neutral-400 sm:block">→</span>}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 text-xs font-bold text-neutral-500">
        <span className="h-px flex-1 bg-neutral-200" />
        {t.explainerResultHeading}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid grid-cols-1 gap-4 rounded-2xl border border-neutral-200 bg-gradient-to-br from-red-50 to-white p-5 sm:grid-cols-[auto_1px_1fr] sm:items-center">
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-sm font-bold text-neutral-700">📈 {t.explainerUpKicker}</p>
            <p className="font-numeric text-4xl font-bold text-red-600">
              {t.explainerUpPct}
              <span className="text-xl">%</span>
            </p>
            <p className="text-xs text-neutral-500">{t.explainerCaption}</p>
          </div>
          <span className="hidden self-stretch bg-neutral-200 sm:block" />
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex items-center gap-2">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-lg">📈</span>
              <span className="text-neutral-400">→</span>
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-lg">🛒</span>
            </div>
            <p className="text-sm text-neutral-700">
              {t.explainerUpUsagePrefix}
              <b className="font-bold text-red-600">{t.explainerUpAction}</b>
              {t.explainerUpUsageSuffix}💡
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 rounded-2xl border border-neutral-200 bg-gradient-to-br from-blue-50 to-white p-5 sm:grid-cols-[auto_1px_1fr] sm:items-center">
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-sm font-bold text-neutral-700">📉 {t.explainerDownKicker}</p>
            <p className="font-numeric text-4xl font-bold text-blue-600">
              {t.explainerDownPct}
              <span className="text-xl">%</span>
            </p>
            <p className="text-xs text-neutral-500">{t.explainerCaption}</p>
          </div>
          <span className="hidden self-stretch bg-neutral-200 sm:block" />
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex items-center gap-2">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-100 text-lg">📉</span>
              <span className="text-neutral-400">→</span>
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-lg">💸</span>
            </div>
            <p className="text-sm text-neutral-700">
              {t.explainerDownUsagePrefix}
              <b className="font-bold text-blue-600">{t.explainerDownAction}</b>
              {t.explainerDownUsageSuffix}💡
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
