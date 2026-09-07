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
  platform: string;      // raw Promo Calendar platform: "Steam" | "Microsoft" | "Sony" | ...
  end_date: string;      // ISO YYYY-MM-DD
  // v3.34 (2026-09-07): richer promo fields for the weekly digest narrative.
  // All are optional so pre-v3.34 call sites keep compiling.
  start_date?: string;   // ISO YYYY-MM-DD
  program?: string;      // e.g. "Steam Autumn Sales", "Publisher Sales", "Gamescom"
  max_discount_pct?: number; // 0..1 fraction (0.6 = 60% off)
  game_label?: string;   // Human-readable title from Promo Calendar
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

// ─── Health tracking (2026-09-07 hardening) ────────────────────────────────
// This client previously failed *silently*: a Promo Calendar contract change
// (endpoint semantics flipped) made every chip disappear with nothing but a
// console.warn buried in droplet logs, so it went unnoticed until a human
// spotted a missing chip against a known-live sale. This tracker gives an
// external caller (see the /api/onpromo/_health route in on-promo-routes.ts)
// a way to ask "is this bridge actually healthy right now" without having to
// re-derive it from scratch the way this investigation had to.
export interface PromoCalendarHealth {
  lastAttemptAt: string | null; // ISO timestamp of the most recent call (success or failure)
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: "none" | "network" | "http_status" | "contract_shape" | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}

const health: PromoCalendarHealth = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorKind: null,
  lastErrorMessage: null,
  consecutiveFailures: 0,
};

function recordSuccess(): void {
  const now = new Date().toISOString();
  health.lastAttemptAt = now;
  health.lastSuccessAt = now;
  health.consecutiveFailures = 0;
}

function recordFailure(kind: Exclude<PromoCalendarHealth["lastErrorKind"], "none" | null>, message: string): void {
  const now = new Date().toISOString();
  health.lastAttemptAt = now;
  health.lastErrorAt = now;
  health.lastErrorKind = kind;
  health.lastErrorMessage = message;
  health.consecutiveFailures += 1;
}

/** Snapshot of the client's health tracker. Used by GET /api/onpromo/_health. */
export function getPromoCalendarHealth(): PromoCalendarHealth {
  return { ...health };
}

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
      // A non-2xx from a same-host loopback call is not routine transient
      // flakiness — it means the route moved, the service is down, or auth
      // changed underneath us. console.error (not warn) so it isn't lost in
      // routine log noise, and tracked so /api/onpromo/_health can surface it.
      const msg = `${code} returned HTTP ${res.status}`;
      console.error(`[promo-calendar] ${msg}; treating as no promos`);
      recordFailure("http_status", msg);
      cache.set(cacheKey, { value: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return [];
    }
    const body = (await res.json()) as NextUpResponse;
    // Contract guard: this is exactly the class of bug that silently broke
    // the badge on 2026-09-04 — the upstream endpoint kept returning 200
    // with a shape that no longer matched what we expected. A response
    // that lacks a `beats` array at all is a contract violation and should
    // be loud; a response with an EMPTY `beats` array is a legitimate "no
    // active campaigns right now" and must stay quiet.
    if (!Array.isArray(body?.beats)) {
      const msg = `${code} response missing/invalid "beats" array (keys: ${body && typeof body === "object" ? Object.keys(body).join(",") : typeof body})`;
      console.error(`[promo-calendar] CONTRACT VIOLATION: ${msg}`);
      recordFailure("contract_shape", msg);
      cache.set(cacheKey, { value: [], expiresAt: Date.now() + CACHE_TTL_MS });
      return [];
    }
    beats = body.beats;
    recordSuccess();
  } catch (err: any) {
    // Network/timeout errors ARE routine (loopback hiccup, service restart
    // mid-deploy) — keep these at warn.
    const msg = err?.message || String(err);
    console.warn(`[promo-calendar] failed to fetch promos for ${code}: ${msg}`);
    recordFailure("network", msg);
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
  //
  // v3.34 (2026-09-07): keep the WHOLE beat (not just end_date) so
  // downstream (weekly digest) can render program name + discount %.
  // When two beats share a platform, keep the one that ends later; if
  // tied, keep the one with the higher max_discount_pct.
  const byPlatform = new Map<string, NextUpBeat>();
  for (const b of active) {
    const existing = byPlatform.get(b.platform);
    if (
      existing == null ||
      b.end_date > existing.end_date ||
      (b.end_date === existing.end_date && (b.max_discount_pct ?? 0) > (existing.max_discount_pct ?? 0))
    ) {
      byPlatform.set(b.platform, b);
    }
  }

  // Sort by soonest-ending end_date first — matches the badge sentence order.
  const result: ActivePromo[] = Array.from(byPlatform.values())
    .map((b) => ({
      platform: b.platform,
      end_date: b.end_date,
      start_date: b.start_date,
      program: b.program,
      max_discount_pct: b.max_discount_pct,
      game_label: b.game_label,
    }))
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

/**
 * Test helper — reset the health tracker to its initial state. Not used in
 * prod code paths.
 */
export function __resetPromoCalendarHealth(): void {
  health.lastAttemptAt = null;
  health.lastSuccessAt = null;
  health.lastErrorAt = null;
  health.lastErrorKind = null;
  health.lastErrorMessage = null;
  health.consecutiveFailures = 0;
}
