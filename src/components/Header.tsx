import Link from "next/link";
import NavLinks from "./NavLinks";
import SearchBar from "./SearchBar";
import AuthButton from "./AuthButton";

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/" className="text-lg font-semibold text-neutral-900">
          MTG DataLab
        </Link>
        <NavLinks />
        <SearchBar />
        <AuthButton />
      </div>
    </header>
  );
}
