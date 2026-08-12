/**
 * Steam Followers Fetcher (Steam Leaderboards — Wishlist board)
 *
 * Ported verbatim from howmanyareplaying/backend/src/services/steamApi.js
 * (`fetchFollowerCount`, PR #80 2026-07-23). There is no Steamworks Partner
 * API endpoint for follower counts — confirmed against Valve's own docs
 * during Phase 0 (see CLAUDE_STEAM_LEADERBOARDS.md §9.2). Follower counts
 * are only exposed on the logged-in "Manage Members" community page, which
 * is not reachable via any documented API. This module hits the SAME public,
 * unauthenticated `memberslistxml` endpoint howmanyareplaying.com already
 * uses in production — `source` on the persisted row is always
 * "public_scrape" to make that lineage explicit to anyone reading the data.
 */

const FOLLOWERS_URL = (appid: number) =>
  `https://steamcommunity.com/games/${appid}/memberslistxml/?xml=1`;

// The memberslistxml response contains TWO memberCount fields:
//   1. Inside <groupDetails>: members of the associated community group. Ignore.
//   2. Top-level <memberCount> (sibling of <groupDetails>): total Steam
//      followers of the game. This is what SteamDB shows as "Followers."
// We extract #2 via a positional regex, matching howmanyareplaying exactly.
const GROUP_DETAILS_RE = /<\/groupDetails>[\s\S]*?<memberCount>(\d+)<\/memberCount>/;

/**
 * Fetch the current follower count for a Steam appid.
 *
 * Empirical Steam behavior (per howmanyareplaying's steamApi.js, measured
 * 2026-07-23, still the governing behavior as of this port):
 *   - Sends HTTP 429 when throttled (not silent 200s).
 *   - No Retry-After header; the cooldown is opaque.
 *   - A single burst of ~60 rapid requests trips the throttle for many
 *     minutes; the community endpoint is much more sensitive than the
 *     store endpoint.
 *
 * Retry strategy: on 429/5xx, back off aggressively (5-15s + attempt*5s
 * jitter) rather than a normal transient's 400-1200ms. The caller
 * (ingestSteamFollowers in ingestion.ts) already paces itself at ~1
 * req/sec between different appids, so an occasional multi-second retry
 * on one title is fine.
 *
 * Permanent failures (404, 403, HTML redirect for released games) return
 * null immediately without retrying — failure is silent, the caller
 * persists null and the UI renders "—".
 */
export async function fetchFollowerCount(
  appid: number,
  { attempts = 4 }: { attempts?: number } = {},
): Promise<number | null> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(FOLLOWERS_URL(appid), {
        headers: { "User-Agent": "signalpulse.saber/wishlist-followers" },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        // fall through to retry with a long backoff
      } else if (!res.ok) {
        return null; // permanent failure (404, 403, etc.) — no point retrying
      } else {
        const xml = await res.text();
        const m = xml.match(GROUP_DETAILS_RE);
        if (!m) return null; // HTML redirect / no match — permanent
        const n = parseInt(m[1], 10);
        return Number.isFinite(n) ? n : null;
      }
    } catch (err: any) {
      lastErr = err;
    }
    // Backoff: 5s + 0-10s jitter + 5s per prior attempt.
    // Attempts land at ~5-15s, ~10-20s, ~15-25s.
    if (i < attempts - 1) {
      const wait = 5000 + Math.floor(Math.random() * 10000) + i * 5000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}
