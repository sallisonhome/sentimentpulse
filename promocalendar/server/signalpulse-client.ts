// Server-side client for the SignalPulse backend.
//
// Reverse direction of `signalpulse/server/promo-calendar-client.ts`:
// SignalPulse owns Steam daily sales; Promo Calendar queries it to enrich
// "Promos Live Now" Steam beats with the revenue accrued so far in the
// current in-flight window.
//
// This module is the ONLY entry point into SignalPulse from Promo Calendar.
// Every call is wrapped in try/catch and returns null on error — a
// SignalPulse outage MUST NOT break a Promo Calendar page render (the
// front-end shows nothing where the revenue chip would go).
//
// The 60-second in-memory cache keeps a single Calendar landing render from
// fanning out ~10 requests every time someone refreshes.

// SignalPulse and Promo Calendar run on the same droplet in prod. Local
// dev also expects a co-located SignalPulse (rare — this call is mostly a
// prod-only enrichment; when SignalPulse is unreachable we just return
// null and the UI hides the chip).
const SIGNALPULSE_BASE_URL =
  process.env.SIGNALPULSE_BASE_URL || "http://127.0.0.1:5000";

const FETCH_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 60_000;

export interface SteamRevenueForWindow {
  steam_app_id: number;
  net_revenue_usd: number;
  gross_revenue_usd: number;
  days_covered: number;
  found: boolean;
}

interface CacheEntry {
  value: SteamRevenueForWindow | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Look up Steam net + gross revenue for a single AppID between two calendar
 * dates (inclusive). `since` and `until` are YYYY-MM-DD.
 *
 * Returns:
 *   - a SteamRevenueForWindow record (may have net=0/days_covered=0 for
 *     titles that exist in SignalPulse but have no rows in the window);
 *   - null if the fetch itself fails (network, timeout, non-200, invalid
 *     JSON). Callers must treat null as "not available" — never as $0.
 */
export async function getSteamRevenueForWindow(
  steamAppId: number,
  since: string,
  until: string,
): Promise<SteamRevenueForWindow | null> {
  const key = `${steamAppId}|${since}|${until}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const url = new URL(`${SIGNALPULSE_BASE_URL}/api/promo-support/steam-revenue`);
  url.searchParams.set("steam_app_id", String(steamAppId));
  url.searchParams.set("since", since);
  url.searchParams.set("until", until);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) {
      // Log at warn level — SignalPulse is best-effort here.
      console.warn(
        `[signalpulse-client] non-200 ${resp.status} for appid=${steamAppId} window=${since}..${until}`,
      );
      cache.set(key, { value: null, expiresAt: now + CACHE_TTL_MS });
      return null;
    }
    const body = (await resp.json()) as SteamRevenueForWindow;
    // Defensive shape check
    if (typeof body?.net_revenue_usd !== "number") {
      console.warn(
        `[signalpulse-client] unexpected body shape for appid=${steamAppId}`,
      );
      cache.set(key, { value: null, expiresAt: now + CACHE_TTL_MS });
      return null;
    }
    cache.set(key, { value: body, expiresAt: now + CACHE_TTL_MS });
    return body;
  } catch (err) {
    // Timeout, DNS, refused connection — all treated as "unavailable".
    if ((err as any)?.name !== "AbortError") {
      console.warn(
        `[signalpulse-client] fetch error for appid=${steamAppId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    cache.set(key, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
