"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** 2〜3文字未満はクエリを発火させない（db/search-design.sql の運用メモ参照） */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;

interface Suggestion {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string | null;
}

export default function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search-suggest?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data: { results: Suggestion[] }) => {
          setSuggestions(data.results);
          setIsOpen(true);
        })
        .catch(() => {
          // AbortErrorは入力中の連打によるキャンセルなので無視してよい
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < MIN_QUERY_LENGTH) return;
    setIsOpen(false);
    router.push(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <div ref={containerRef} className="relative w-full sm:w-56">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => suggestions.length > 0 && setIsOpen(true)}
          placeholder="カード名を検索"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 hover:border-neutral-500"
        >
          検索
        </button>
      </form>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-col overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
          {suggestions.map((card) => (
            <Link
              key={card.oracleId}
              href={`/cards/${card.oracleId}`}
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-left hover:bg-neutral-50"
            >
              {card.artCropUrl ? (
                <Image
                  src={card.artCropUrl}
                  alt=""
                  width={28}
                  height={28}
                  className="h-7 w-7 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="h-7 w-7 shrink-0 rounded bg-neutral-100" />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-900">{card.nameJa}</p>
                <p className="truncate text-xs text-neutral-500">{card.nameEn}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
