"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { totalPriceJpy, totalArenaPriceJpy, arenaPriceJpy, formatJpy } from "@/lib/deckPricing";
import ManaCost from "./ManaCost";

export interface DeckCardDisplay {
  oracleId: string | null;
  nameEn: string;
  nameJa: string | null;
  artCropUrl: string | null;
  imageNormalUrl: string | null;
  priceJpy: number | null;
  typeLine: string | null;
  manaCost: string | null;
  quantity: number;
  board: "main" | "side";
  /** common/uncommon/rare/mythic。MTG Arenaワイルドカード換算表示用（Standardのみ） */
  rarity: string | null;
}

type Tab = "list" | "image";
type CardKind = "creature" | "spell" | "land";

const KIND_LABEL: Record<CardKind, string> = {
  creature: "クリーチャー",
  spell: "呪文",
  land: "土地",
};
const KIND_ORDER: CardKind[] = ["creature", "spell", "land"];

/** 土地・クリーチャー以外は全て「呪文」扱い（type_line不明のカードも呪文に含める） */
function classifyKind(typeLine: string | null): CardKind {
  if (typeLine?.includes("Land")) return "land";
  if (typeLine?.includes("Creature")) return "creature";
  return "spell";
}

/**
 * インポート元データの都合で同じカードが複数行に分かれて記録されていることがある
 * （例: "Riverglide Pathway"が1枚・3枚の2行に分かれ、合計は正しいのに表示が2行になる）。
 * 同名・同ボードの行は合算し、1枚として表示する。
 */
function mergeDuplicateCards(cards: DeckCardDisplay[]): DeckCardDisplay[] {
  const byKey = new Map<string, DeckCardDisplay>();
  for (const card of cards) {
    const key = `${card.nameEn}-${card.board}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      byKey.set(key, { ...card });
    }
  }
  return [...byKey.values()];
}

function groupCards(cards: DeckCardDisplay[], board: "main" | "side") {
  return mergeDuplicateCards(cards.filter((c) => c.board === board));
}

/** 同カテゴリー内の並び順: 枚数が多い順、同枚数なら金額（1枚あたり）が高い順 */
function byQuantityThenPrice(a: DeckCardDisplay, b: DeckCardDisplay) {
  if (b.quantity !== a.quantity) return b.quantity - a.quantity;
  return (b.priceJpy ?? -1) - (a.priceJpy ?? -1);
}

function groupByKind(cards: DeckCardDisplay[]): { kind: CardKind; cards: DeckCardDisplay[] }[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    cards: cards.filter((c) => classifyKind(c.typeLine) === kind).sort(byQuantityThenPrice),
  })).filter((g) => g.cards.length > 0);
}

/**
 * クリーチャー→呪文→土地の順に並び替えるだけで、グループの見出し・小計は付けない（サイドボード表示用）。
 * 同カテゴリー内は枚数が多い順、同枚数なら金額が高い順。
 */
function sortByKind(cards: DeckCardDisplay[]): DeckCardDisplay[] {
  const rank = (c: DeckCardDisplay) => KIND_ORDER.indexOf(classifyKind(c.typeLine));
  return [...cards].sort((a, b) => rank(a) - rank(b) || byQuantityThenPrice(a, b));
}

function totalQuantity(cards: DeckCardDisplay[]) {
  return cards.reduce((sum, c) => sum + c.quantity, 0);
}

export default function DeckDetailView({
  cards,
  format,
  title,
  subtitle,
}: {
  cards: DeckCardDisplay[];
  format?: string;
  /** 未指定ならタイトル行自体を出さない（呼び出し側が既に独自のヘッダーを持つ場合。
   * src/app/decks/archetype/[archetypeId]/page.tsx参照） */
  title?: string;
  subtitle?: string;
}) {
  const [tab, setTab] = useState<Tab>("image");
  // MTG Arenaで実際に組む対象はローテーション中のStandardが中心なため、換算表示はStandardのみ出す。
  const isStandard = format === "Standard";
  const [arenaMode, setArenaMode] = useState(false);
  // ヘッダーの合計金額もチェックボックスと連動して切り替える（メイン・サイド両方の合計、
  // 従来page.tsx側で計算していたtotalPriceJpy(deck.cards)と同じ範囲）
  const grandTotalJpy = arenaMode ? totalArenaPriceJpy(cards) : totalPriceJpy(cards);

  const mainboard = groupCards(cards, "main");
  const sideboard = groupCards(cards, "side");
  // Commanderはboard='side'に統率者が入る（TopDeck.ggのdeckObjの"Commanders"キー由来）。
  // サイドボードという概念自体がCommanderには存在しないため表示ラベルを変える。
  const isCommander = format === "Commander";
  const sideboardTitle = isCommander ? "統率者" : "サイドボード";

  return (
    <div className="flex flex-col gap-4">
      {title !== undefined && (
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-neutral-500">{subtitle}</p>
          </div>
          <p className="whitespace-nowrap text-lg font-semibold">
            {arenaMode && "Arena換算 "}
            {formatJpy(grandTotalJpy)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          onClick={() => setTab("list")}
          className={`rounded-md border px-3 py-1.5 ${
            tab === "list"
              ? "border-neutral-500 bg-neutral-100 text-neutral-900"
              : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
          }`}
        >
          リスト（画像なし）
        </button>
        <button
          onClick={() => setTab("image")}
          className={`rounded-md border px-3 py-1.5 ${
            tab === "image"
              ? "border-neutral-500 bg-neutral-100 text-neutral-900"
              : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
          }`}
        >
          画像（グリッド）
        </button>
        {isStandard && (
          <label
            title="ワイルドカード換算：レア¥1,500/4枚、神話レア¥3,000/4枚、コモン・アンコモン¥0"
            className="ml-auto flex w-fit cursor-help items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-600"
          >
            <input
              type="checkbox"
              checked={arenaMode}
              onChange={(e) => setArenaMode(e.target.checked)}
              className="h-4 w-4"
            />
            MTG Arena換算で表示
          </label>
        )}
      </div>

      {tab === "list" ? (
        <div className="flex flex-col gap-6">
          {isCommander && sideboard.length > 0 && (
            <DeckCardList title={sideboardTitle} cards={sideboard} grouped={false} arenaMode={arenaMode} />
          )}
          <DeckCardList title="メインボード" cards={mainboard} grouped arenaMode={arenaMode} />
          {!isCommander && sideboard.length > 0 && (
            <DeckCardList title={sideboardTitle} cards={sideboard} grouped={false} arenaMode={arenaMode} />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {isCommander && sideboard.length > 0 && (
            <DeckCardGrid title={sideboardTitle} cards={sideboard} grouped={false} arenaMode={arenaMode} />
          )}
          <DeckCardGrid title="メインボード" cards={mainboard} grouped arenaMode={arenaMode} />
          {!isCommander && sideboard.length > 0 && (
            <DeckCardGrid title={sideboardTitle} cards={sideboard} grouped={false} arenaMode={arenaMode} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 親の<ul>がgrid-cols-[1fr_auto_auto_auto]である前提。liは"contents"で自身を消し、
 * 中の4つのspanが親のグリッド列（名前・単価・枚数・合計）にそのまま並ぶことで、
 * カード名の長さに関わらず単価/枚数/合計が縦に揃う。
 */
function CardListRow({ card, arenaMode }: { card: DeckCardDisplay; arenaMode: boolean }) {
  // arenaMode中はレアリティさえ分かれば必ず金額が出せる（不明なレアリティ・コモン/アンコモンは0円）ため、
  // 実勢価格が無いカードでも「価格データなし」にはならない
  const unitPriceJpy = arenaMode ? arenaPriceJpy(card.rarity) : card.priceJpy;
  return (
    <li key={`${card.nameEn}-${card.board}`} className="contents">
      <span className="flex min-w-0 items-center gap-1.5 truncate border-b border-neutral-100 py-1">
        <span className="truncate">
          {card.quantity}x{" "}
          {card.oracleId ? (
            <Link href={`/cards/${card.oracleId}`} className="hover:underline">
              {card.nameJa ?? card.nameEn}
            </Link>
          ) : (
            card.nameJa ?? card.nameEn
          )}
        </span>
        <ManaCost cost={card.manaCost} />
      </span>
      {unitPriceJpy !== null ? (
        <>
          <span className="whitespace-nowrap border-b border-neutral-100 py-1 text-right text-neutral-400 tabular-nums">
            ¥{unitPriceJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
          </span>
          <span className="whitespace-nowrap border-b border-neutral-100 py-1 text-right text-neutral-400 tabular-nums">
            ×{card.quantity}
          </span>
          <span className="whitespace-nowrap border-b border-neutral-100 py-1 text-right text-neutral-600 tabular-nums">
            ¥{(unitPriceJpy * card.quantity).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
          </span>
        </>
      ) : (
        <span className="col-span-3 whitespace-nowrap border-b border-neutral-100 py-1 text-right text-neutral-400">
          価格データなし
        </span>
      )}
    </li>
  );
}

function DeckCardList({
  title,
  cards,
  grouped,
  arenaMode,
}: {
  title: string;
  cards: DeckCardDisplay[];
  grouped: boolean;
  arenaMode: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-neutral-700">
        {title}（{totalQuantity(cards)}）
      </p>
      {grouped ? (
        <div className="columns-1 gap-6 sm:columns-2">
          {groupByKind(cards).map((group) => (
            <div key={group.kind} className="mb-4 break-inside-avoid">
              <p className="mb-1 text-xs font-medium text-neutral-500">
                {KIND_LABEL[group.kind]}（{totalQuantity(group.cards)}）
              </p>
              <ul className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-sm">
                {group.cards.map((card) => (
                  <CardListRow key={`${card.nameEn}-${card.board}`} card={card} arenaMode={arenaMode} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-sm">
          {sortByKind(cards).map((card) => (
            <CardListRow key={`${card.nameEn}-${card.board}`} card={card} arenaMode={arenaMode} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-right text-sm font-medium text-neutral-700">
        合計: {formatJpy(arenaMode ? totalArenaPriceJpy(cards) : totalPriceJpy(cards))}
      </p>
    </div>
  );
}

function CardGridTile({ card }: { card: DeckCardDisplay }) {
  const content = (
    <>
      {card.imageNormalUrl ? (
        <Image
          src={card.imageNormalUrl}
          alt={card.nameEn}
          width={223}
          height={311}
          className="w-full rounded-md object-contain"
        />
      ) : (
        <div className="flex aspect-[223/311] w-full items-center justify-center rounded-md bg-neutral-100 text-[10px] text-neutral-400">
          画像なし
        </div>
      )}
      <p className="text-center text-xs">
        {card.quantity}x {card.nameJa ?? card.nameEn}
      </p>
    </>
  );

  if (card.oracleId) {
    return (
      <Link
        href={`/cards/${card.oracleId}`}
        className="flex flex-col items-center gap-1 hover:opacity-80"
      >
        {content}
      </Link>
    );
  }
  return <div className="flex flex-col items-center gap-1">{content}</div>;
}

function DeckCardGrid({
  title,
  cards,
  grouped,
  arenaMode,
}: {
  title: string;
  cards: DeckCardDisplay[];
  grouped: boolean;
  arenaMode: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-neutral-700">
        {title}（{totalQuantity(cards)}）
      </p>
      {grouped ? (
        <div className="flex flex-col gap-4">
          {groupByKind(cards).map((group) => (
            <div key={group.kind}>
              <p className="mb-1 text-xs font-medium text-neutral-500">
                {KIND_LABEL[group.kind]}（{totalQuantity(group.cards)}）
              </p>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {group.cards.map((card) => (
                  <CardGridTile key={`${card.nameEn}-${card.board}`} card={card} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {sortByKind(cards).map((card) => (
            <CardGridTile key={`${card.nameEn}-${card.board}`} card={card} />
          ))}
        </div>
      )}
      <p className="mt-2 text-right text-sm font-medium text-neutral-700">
        合計: {formatJpy(arenaMode ? totalArenaPriceJpy(cards) : totalPriceJpy(cards))}
      </p>
    </div>
  );
}
