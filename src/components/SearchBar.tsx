"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { meetsMinQueryLength } from "@/lib/searchQuery";
import { useLocale } from "@/i18n/useLocale";
import { getDictionary } from "@/i18n/getDictionary";

const DEBOUNCE_MS = 200;

interface Suggestion {
  oracleId: string;
  nameJa: string;
  nameEn: string;
  artCropUrl: string | null;
}

export default function SearchBar() {
  const router = useRouter();
  const locale = useLocale();
  const t = getDictionary(locale);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!meetsMinQueryLength(trimmed)) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search-suggest?q=${encodeURIComponent(trimmed)}&locale=${locale}`, { signal: controller.signal })
        .then((res) => res.json() as Promise<{ results: Suggestion[] }>)
        .then((data) => {
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
    if (!meetsMinQueryLength(query.trim())) return;
    setIsOpen(false);
    router.push(`/${locale}/search?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <div ref={containerRef} className="relative w-full sm:w-56">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => suggestions.length > 0 && setIsOpen(true)}
          placeholder={t.searchPlaceholder}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400"
        />
        <button
          type="submit"
          className="shrink-0 whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 hover:border-neutral-500"
        >
          {t.searchButton}
        </button>
      </form>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-col overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
          {suggestions.map((card) => (
            <Link
              key={card.oracleId}
              href={`/${locale}/cards/${card.oracleId}`}
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
                <p className="truncate text-sm font-medium text-neutral-900">
                  {locale === "ja" ? card.nameJa : card.nameEn}
                </p>
                {locale === "ja" && <p className="truncate text-xs text-neutral-500">{card.nameEn}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
