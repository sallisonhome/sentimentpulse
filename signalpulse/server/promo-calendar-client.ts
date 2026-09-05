// Server-side client for the Promo Calendar backend.
//
// The Promo Calendar is a separate service that runs on port 5003 on the
// same droplet as SignalPulse. In production nginx exposes it at
// `/promo/api/*`; server-to-server we hit it directly on 127.0.0.1:5003 to
// skip the reverse proxy.
//
// This client is the ONLY entry point into the Promo Calendar from
// SignalPulse. Every call is wrapped in try/catch and falls back to `[]`
// on error — a Promo Calendar outage must never break a SignalPulse page.
// The 60-second in-memory cache keeps leaderboard renders from fanning out
// dozens of requests to the promo backend on every refresh.

import { promoCodeForSteamAppId } from "./promo-calendar-map";

// Config: the Promo Calendar base URL. In local dev and in prod both apps
// run on the same host, so 127.0.0.1:5003 is correct in both environments.
// Overridable via `PROMO_CALENDAR_BASE_URL` if the promo service ever moves.
const PROMO_CALENDAR_BASE_URL =
  process.env.PROMO_CALENDAR_BASE_URL || "http://127.0.0.1:5003";

// Fetch timeout — the promo backend is on localhost so it should answer in
// single-digit ms. If it doesn't, we bail rather than hang a leaderboard
// render behind a slow request.
const FETCH_TIMEOUT_MS = 2000;

// Cache TTL. Promo campaigns are keyed on `end_date` (day granularity) so
// even 5 minutes would be safe; 60s is a conservative compromise.
const CACHE_TTL_MS = 60_000;

export interface ActivePromo {
  platform: string; // raw Promo Calendar platform: "Steam" | "Microsoft" | "Sony" | ...
  end_date: string; // ISO YYYY-MM-DD
}

interface NextUpBeat {
  campaign_id: number;
  game_code: string;
  game_label: string;
  platform: string;
  program: string;
  start_date: string;
  end_date: string;
  max_discount_pct: number;
  days_until_start: number;
  is_active: boolean;
}

interface NextUpResponse {
  calendar: string;
  game_code: string;
  today: string;
  beats: NextUpBeat[];
}

interface CacheEntry {
  value: ActivePromo[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Return the current server date as YYYY-MM-DD in the server's local zone.
 * The Promo Calendar API is server-anchored — it accepts `today` and drops
 * any beat whose end_date is before that. We pass today explicitly so this
 * client's behaviour is deterministic in tests.
 */
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fetch active promos for a single Saber title, keyed by Steam AppID.
 *
 * Behaviour:
 *  - AppID not in the mapping table → `[]` (no fetch, cheap).
 *  - Network / non-2xx / parse error → `[]` (logged as a warning).
 *  - Success → filters to `is_active === true`, deduplicates by platform
 *    (keeping the latest `end_date` per platform), sorts by soonest-
 *    ending `end_date` first.
 *
 * Results are cached in-memory for 60 seconds per (game_code, today) so a
 * leaderboard fan-out doesn't hammer the promo backend.
 */
export async function getActivePromosFor(
  steamAppId: number,
  today: string = todayIso(),
): Promise<ActivePromo[]> {
  const code = promoCodeForSteamAppId(steamAppId);
  if (!code) return [];

  const cacheKey = `${code}::${today}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let beats: NextUpBeat[] = [];
  try {
    // v3.30 (2026-09-05): switched from /next-up to /live-now.
    //
    // Backstory: on 2026-09-04, the Promo Calendar's /next-up endpoint was
    // changed to STRICTLY exclude in-flight beats (start_date > today), so
    // it only returns future beats now. SignalPulse's On Promo badge
    // depends on currently-active beats — filtering /next-up by
    // `is_active` therefore yields zero, and every chip disappeared even
    // when titles were actively on sale. The correct endpoint is
    // /live-now, which returns exactly the currently in-flight beats and
    // was added as the counterpart to that Next Up change.
    const url = `${PROMO_CALENDAR_BASE_URL}/api/saber/games/${encodeURIComponent(code)}/live-now?today=${today}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.warn(`[promo-calendar] ${code} returned HTTP ${res.status}; treating as no promos`);
      cache.set(cacheKey, { value: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return [];
    }
    const body = (await res.json()) as NextUpResponse;
    beats = Array.isArray(body?.beats) ? body.beats : [];
  } catch (err: any) {
    console.warn(`[promo-calendar] failed to fetch promos for ${code}: ${err?.message || err}`);
    // Cache the empty result briefly to avoid retrying every leaderboard
    // render while the promo service is down.
    cache.set(cacheKey, { value: [], expiresAt: Date.now() + CACHE_TTL_MS });
    return [];
  }

  // /live-now returns only currently in-flight beats — no need to filter
  // by `is_active` (the endpoint's contract IS "active right now"). We
  // still defensively treat any beat present in the response as active
  // even if the shape lacks the flag.
  const active = beats.filter((b) => b.is_active !== false);

  // Deduplicate by platform: if a title has two overlapping Steam sales
  // (e.g. Autumn Sale + a franchise sale), collapse to one entry and keep
  // whichever ends LATER. Users only see "Steam through <date>" once.
  const byPlatform = new Map<string, string>();
  for (const b of active) {
    const existing = byPlatform.get(b.platform);
    if (existing == null || b.end_date > existing) {
      byPlatform.set(b.platform, b.end_date);
    }
  }

  // Sort by soonest-ending end_date first — matches the badge sentence order.
  const result: ActivePromo[] = Array.from(byPlatform.entries())
    .map(([platform, end_date]) => ({ platform, end_date }))
    .sort((a, b) => (a.end_date < b.end_date ? -1 : a.end_date > b.end_date ? 1 : 0));

  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Fetch active promos for every mapped Saber title. Used by the leaderboards
 * (one call per page load) and the Dashboard "On Promo Now" card. Fans out
 * in parallel; each per-title fetch has its own try/catch so a single
 * failure doesn't take down the whole response.
 *
 * Returns a plain object keyed by Steam AppID (as string, so it survives
 * JSON round-trip cleanly), with the active-promo list as the value.
 * Titles with no active promos are OMITTED from the result — callers can
 * safely `Object.keys(x).length === 0` to render the empty state.
 */
export async function getAllActivePromos(
  today: string = todayIso(),
): Promise<Record<string, ActivePromo[]>> {
  const { STEAM_APPID_TO_PROMO_CODE } = await import("./promo-calendar-map");
  const appIds = Object.keys(STEAM_APPID_TO_PROMO_CODE).map(Number);
  const results = await Promise.all(
    appIds.map(async (appId) => {
      const promos = await getActivePromosFor(appId, today);
      return [appId, promos] as const;
    }),
  );
  const out: Record<string, ActivePromo[]> = {};
  for (const [appId, promos] of results) {
    if (promos.length > 0) out[String(appId)] = promos;
  }
  return out;
}

/**
 * Test helper — flush the in-memory cache. Not used in prod code paths.
 */
export function __resetPromoCalendarCache(): void {
  cache.clear();
}
