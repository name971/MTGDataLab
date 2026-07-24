import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <p className="text-4xl font-semibold text-neutral-300">404</p>
      <p className="text-sm text-neutral-600">お探しのページが見つかりませんでした。</p>
      <Link
        href="/"
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500"
      >
        トップページへ戻る
      </Link>
    </div>
  );
}
