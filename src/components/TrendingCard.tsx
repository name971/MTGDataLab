import Image from "next/image";
import Link from "next/link";

/**
 * 取引量は無料データソースが存在しないため launch では対象外（docs/spec.md 2章）。
 * カテゴリは価格・採用率の2軸のみで運用する。
 */
export interface TrendingCardData {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string;
  category: "price" | "usage";
  priceJpy: number;
  changeLabel: string;
  streakDays: number;
}

const CATEGORY_LABEL: Record<TrendingCardData["category"], string> = {
  price: "価格上昇",
  usage: "採用率上昇",
};

const CATEGORY_BADGE_CLASS: Record<TrendingCardData["category"], string> = {
  price: "bg-purple-50 text-purple-800",
  usage: "bg-orange-50 text-orange-800",
};

export default function TrendingCard({ card }: { card: TrendingCardData }) {
  // Scryfallの画像URLは /<バリエーション>/front/<...>.jpg という共通構造なので、
  // art_cropの1枚絵ではなくカード全体（normal）の画像に差し替える
  const normalImageUrl = card.artCropUrl.replace("/art_crop/", "/normal/");

  return (
    <Link
      href={`/cards/${card.oracleId}`}
      className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 hover:border-neutral-400"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${CATEGORY_BADGE_CLASS[card.category]}`}
          >
            {CATEGORY_LABEL[card.category]}
          </span>
          {/* このセクションの主眼は「何日連続で上がり続けているか」なので、1日目でも常に表示する */}
          <span className="inline-block rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-700">
            {card.streakDays}日連続
          </span>
        </div>
        <p className="mt-1 truncate text-sm font-medium">{card.nameJa}</p>
        <p className="text-sm">
          ¥{card.priceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}{" "}
          <span
            className={`text-xs ${
              card.changeLabel.startsWith("-") ? "text-red-800" : "text-teal-800"
            }`}
          >
            {card.changeLabel}
          </span>
        </p>
      </div>
      <Image
        src={normalImageUrl}
        alt={card.nameEn}
        width={223}
        height={311}
        className="w-full rounded-md object-contain"
      />
    </Link>
  );
}
