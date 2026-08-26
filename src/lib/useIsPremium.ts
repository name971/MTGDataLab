"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type PremiumStatus = "loading" | "anonymous" | "free" | "premium";

/** 会員登録（Supabase Auth+Google）は実装済みだが決済連携は未実装のため、is_premiumを
 * 手動でtrueにしない限り常に"free"/"anonymous"になる（有料会員機能として後日、
 * 決済連携時にis_premiumを自動更新する想定）。MlRankingList.tsx・WeeklyMoversList.tsxの
 * 両方が同じ判定ロジックを重複させていたため切り出した。 */
export function useIsPremium(): PremiumStatus {
  const [status, setStatus] = useState<PremiumStatus>("loading");
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        setStatus("anonymous");
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("is_premium").eq("id", data.user.id).single();
      setStatus(profile?.is_premium ? "premium" : "free");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabaseクライアントは毎回新規参照になるため依存に含めない
  }, []);

  return status;
}
