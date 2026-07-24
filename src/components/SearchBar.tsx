"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 2〜3文字未満はクエリを発火させない（db/search-design.sql の運用メモ参照） */
const MIN_QUERY_LENGTH = 2;

export default function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < MIN_QUERY_LENGTH) return;
    router.push(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="カード名を検索"
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 sm:w-56"
      />
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 hover:border-neutral-500"
      >
        検索
      </button>
    </form>
  );
}
