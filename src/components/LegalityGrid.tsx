import { FORMATS, formatSlug } from "@/lib/formats";

const STATUS_LABEL: Record<string, string> = {
  legal: "✓",
  not_legal: "–",
  banned: "✕",
  restricted: "1",
};

const STATUS_TITLE: Record<string, string> = {
  legal: "合法",
  not_legal: "非合法",
  banned: "禁止",
  restricted: "制限（1枚まで）",
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
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
      {FORMATS.map((format) => {
        const status = disabled ? "print_not_legal" : (legalities[formatSlug(format)] ?? "not_legal");
        return (
          <div key={format} className="flex w-fit items-center gap-2">
            <dt className="w-24 text-neutral-600">{format}</dt>
            <dd
              className={`font-semibold ${disabled ? "text-red-800" : (STATUS_CLASS[status] ?? "text-neutral-400")}`}
              title={disabled ? "このプリントは使用不可" : (STATUS_TITLE[status] ?? status)}
            >
              {disabled ? "✕" : (STATUS_LABEL[status] ?? status)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
