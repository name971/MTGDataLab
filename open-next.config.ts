import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";

// R2はクレカ登録が必要なため見送り、無料枠のみで使えるKV（wrangler.jsonc、
// NEXT_INC_CACHE_KV）をISRの永続ストアにする。同一データセンター内はさらに
// Workers標準のCache API（regional cache）で応答し、KVへの読み取り回数（無料枠: 10万/日）も抑える。
export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(kvIncrementalCache, { mode: "long-lived" }),
});
