import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import dummyIncrementalCache from "@opennextjs/aws/overrides/incrementalCache/dummy.js";

// R2/KVバインディングは無い（Supabase egress対策のためのISRキャッシュ用にR2を用意するには
// Cloudflareアカウントへのクレカ登録が必要で、今回は見送った）。永続ストア無しでも、
// Workers標準のCache API（同一データセンター内でのみ有効、追加コスト無し）を使えば
// 同じPOPへの再訪問はSupabaseに問い合わせずに済む。永続ストアがdummy（＝ミス時は毎回オリジンへ）
// なので、これは「datacenterローカルの一時キャッシュ」として働く。
export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(dummyIncrementalCache, { mode: "long-lived" }),
});
