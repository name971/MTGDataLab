"use client";

import { FORMATS, formatSlug, formatLabel } from "@/lib/formats";
import { useLocale } from "@/i18n/useLocale";
import { getDictionary } from "@/i18n/getDictionary";

const STATUS_LABEL: Record<string, string> = {
  legal: "✓",
  not_legal: "–",
  banned: "✕",
  restricted: "1",
};

const STATUS_CLASS: Record<string, string> = {
  legal: "text-teal-800",
  not_legal: "text-neutral-400",
  banned: "text-red-800",
  restricted: "text-amber-800",
};

export default function LegalityGrid({
  legalities,
  disabled = false,
}: {
  legalities: Record<string, string>;
  /** 金縁・銀縁等の特殊プリントを選択中は、オラクルの合法性に関わらず
   * このプリント自体はどのフォーマットでも使用できないため、全項目を使用不可表示にする */
  disabled?: boolean;
}) {
  const locale = useLocale();
  const t = getDictionary(locale).legality;
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      {FORMATS.map((format) => {
        const status = disabled ? "print_not_legal" : (legalities[formatSlug(format)] ?? "not_legal");
        return (
          <div key={format} className="flex items-center justify-between gap-2">
            <dt className="text-neutral-600">{formatLabel(format, locale)}</dt>
            <dd
              className={`font-semibold ${disabled ? "text-red-800" : (STATUS_CLASS[status] ?? "text-neutral-400")}`}
              title={disabled ? t.printNotLegalTitle : (t.statusTitle[status as keyof typeof t.statusTitle] ?? status)}
            >
              {disabled ? "✕" : (STATUS_LABEL[status] ?? status)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
