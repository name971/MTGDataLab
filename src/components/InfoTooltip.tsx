"use client";

import { useState } from "react";

export default function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        aria-label="説明を表示"
        className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-400 text-[10px] leading-none text-neutral-500 hover:border-neutral-600 hover:text-neutral-700"
      >
        ?
      </button>
      {open && (
        <span className="absolute left-1/2 top-6 z-10 w-64 -translate-x-1/2 rounded-md border border-neutral-200 bg-white p-2.5 text-xs leading-relaxed text-neutral-600 shadow-md">
          {text}
        </span>
      )}
    </span>
  );
}
