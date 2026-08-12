/**
 * IGDB Hype Fetcher (Steam Leaderboards — Wishlist board)
 *
 * SOURCE: howmanyareplaying.com's public, unauthenticated wishlist API —
 * https://howmanyareplaying.com/api/wishlist — rather than calling IGDB
 * directly. That endpoint already runs the exact IGDB `hypes` lookup for
 * every game in Steam's global Top 200 upcoming-wishlisted list and
 * publishes `igdb_hype` per row. SignalPulse just matches Saber's Steam
 * appids against that payload — no IGDB/Twitch Client ID or Secret needed
 * anywhere in this app.
 *
 * KNOWN LIMITATION (accepted 2026-08-12 per user decision): this only
 * covers appids that are currently in the global Top 200 upcoming
 * wishlisted list. A pre-release Saber title ranked outside that Top 200
 * gets no entry here — caller persists igdbId=null, hypeScore=null and
 * the UI renders "—", not a fabricated 0. As a title's own Steam wishlist
 * rank rises into the Top 200 (tracked separately by
 * ingestSteamWishlistRank against Steam's own popularwishlist listing —
 * a different, Saber-title-scoped fetch), it will start picking up a hype
 * score here automatically on the next daily run.
 */

import { log } from "./index";

const HMAP_WISHLIST_URL = "https://howmanyareplaying.com/api/wishlist";

interface HmapWishlistRow {
  appid?: number;
  igdb_id?: number | null;
  igdb_hype?: number | null;
}

interface HmapWishlistResponse {
  data?: HmapWishlistRow[];
}

/**
 * Fetch IGDB Hype scores for a list of Steam appids by matching against
 * howmanyareplaying.com's public Top 200 upcoming-wishlisted list.
 *
 * Returns a Map<steamAppid, { igdbId, hypeScore }>. An appid ABSENT from
 * the map means it's not currently in the Top 200 (caller should persist
 * igdbId=null, hypeScore=null). An appid present with `hypeScore: null`
 * means howmanyareplaying has the title in its Top 200 but IGDB has no
 * hype data for it yet — render as "—", never 0.
 */
export async function fetchIgdbHypesBySteamAppids(
  steamAppids: number[],
): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const wanted = new Set(steamAppids.filter((n) => Number.isInteger(n)));
  const result = new Map<number, { igdbId: number; hypeScore: number | null }>();
  if (wanted.size === 0) return result;

  const res = await fetch(HMAP_WISHLIST_URL, {
    headers: { "User-Agent": "signalpulse.saber/igdb-hype-via-hmap" },
  });
  if (!res.ok) {
    throw new Error(`howmanyareplaying wishlist API responded HTTP ${res.status}`);
  }

  const json = (await res.json()) as HmapWishlistResponse;
  const rows = json?.data;
  if (!Array.isArray(rows)) {
    throw new Error("howmanyareplaying wishlist API returned unexpected response shape");
  }

  for (const row of rows) {
    if (typeof row.appid !== "number" || !wanted.has(row.appid)) continue;
    if (!Number.isInteger(row.igdb_id)) continue; // no IGDB match — leave absent from map
    result.set(row.appid, {
      igdbId: row.igdb_id as number,
      hypeScore: Number.isFinite(row.igdb_hype as number) ? (row.igdb_hype as number) : null,
    });
  }

  log(
    `[igdb] matched ${result.size}/${wanted.size} Saber appids against howmanyareplaying's Top 200 (${rows.length} rows fetched)`,
    "igdb",
  );
  return result;
}
