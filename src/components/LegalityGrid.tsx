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

export default function LegalityGrid({ legalities }: { legalities: Record<string, string> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {FORMATS.map((format) => {
        const status = legalities[formatSlug(format)] ?? "not_legal";
        return (
          <div key={format} className="flex items-center justify-between">
            <dt className="text-neutral-600">{format}</dt>
            <dd
              className={`font-semibold ${STATUS_CLASS[status] ?? "text-neutral-400"}`}
              title={STATUS_TITLE[status] ?? status}
            >
              {STATUS_LABEL[status] ?? status}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
