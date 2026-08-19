"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function AuthButton() {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  if (email === undefined) return null;

  if (email === null) {
    return (
      <button
        type="button"
        onClick={() =>
          supabase.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: `${window.location.origin}/auth/callback` },
          })
        }
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-500"
      >
        ログイン
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-neutral-600">
      <span className="max-w-[10rem] truncate">{email}</span>
      <button
        type="button"
        onClick={() => supabase.auth.signOut()}
        className="text-neutral-400 hover:text-neutral-600"
      >
        ログアウト
      </button>
    </div>
  );
}
