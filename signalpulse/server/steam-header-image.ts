/**
 * Steam Header Image Fetcher (Steam Leaderboards — key art)
 *
 * v3.14 (2026-08-12): fixes corrupted key art for Rideshare Stimulator and
 * Jurassic Park: Survival (and any future title in the same situation).
 * Root cause: leaderboards.ts previously *synthesized* a header image URL
 * from the well-known pattern
 *   https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg
 * Steam has migrated some titles' store assets to hashed Akamai paths
 * (store_item_assets/steam/apps/{appid}/{hash}/header.jpg), which makes the
 * synthesized URL 404 for those titles. This module fetches the REAL
 * header_image URL from Steam's public, unauthenticated appdetails API and
 * caches it on products.steam_header_image_url so we only pay the network
 * cost once (refreshed periodically by ingestion, not per page load).
 *
 * appdetails only supports ONE appid per request when you need full detail
 * fields like header_image (the multi-appid batch form silently drops to a
 * price-only response), so callers must loop and pace themselves — this
 * module makes no assumption about calling frequency, that's the caller's
 * job (see ingestHeaderImages in ingestion.ts).
 */

const APPDETAILS_URL = (appid: number) =>
  `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;

/**
 * Fetch the current header_image URL for a Steam appid, or null if the
 * title isn't found / has no header image / the request fails permanently.
 *
 * Retry strategy mirrors steam-followers.ts: short attempts, back off hard
 * on 429/5xx since appdetails shares Steam's store-side rate limiting.
 */
export async function fetchHeaderImage(
  appid: number,
  { attempts = 3 }: { attempts?: number } = {},
): Promise<string | null> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(APPDETAILS_URL(appid), {
        headers: { "User-Agent": "signalpulse.saber/wishlist-header-image" },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        return null; // permanent failure (404, 403, etc.)
      } else {
        const json = await res.json();
        const entry = json?.[String(appid)];
        if (!entry?.success || !entry?.data?.header_image) return null;
        return entry.data.header_image as string;
      }
    } catch (err: any) {
      lastErr = err;
    }
    if (i < attempts - 1) {
      const wait = 3000 + Math.floor(Math.random() * 5000) + i * 3000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (lastErr) {
    // Exhausted retries on a transient error — caller treats this the same
    // as "no image found" (keeps whatever was cached before, if anything).
    return null;
  }
  return null;
}
