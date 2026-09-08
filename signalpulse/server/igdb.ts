/**
 * IGDB Hype Fetcher (Steam Leaderboards — Wishlist board)
 *
 * v4.2 (2026-08-14): direct IGDB v4 calls, ported from howmanyareplaying's
 * services/twitchAuth.js + services/igdbApi.js — same Twitch Client
 * Credentials token endpoint, same IGDB /games endpoint, same
 * external_game_source=1 Steam-match rule, same 401/429 retry policy.
 * Only field list differs: SignalPulse only needs `hypes`, not HMAP's full
 * genres/themes/ratings/media field set.
 *
 * Credentials (`twitch_client_id` / `twitch_client_secret`) live in
 * SignalPulse's own Settings page (app_settings table), NOT env vars —
 * unlike HMAP's droplet, which reads them from its own .env. There is no
 * way to read HMAP's droplet env from this app, so the user re-enters the
 * same Twitch Developer Console values here once.
 *
 * FALLBACK: if either credential is unset, this module falls back to the
 * pre-v4.2 behavior — howmanyareplaying.com's public, unauthenticated
 * /api/wishlist endpoint, which only covers the global Top 200 upcoming-
 * wishlisted list. Once both credentials are set, ALL Saber leaderboard
 * titles get a hype score regardless of global rank, and the HMAP proxy is
 * never called. If credentials ARE set but a direct call fails (exhausted
 * 429 retries, 5xx, bad creds), the error is surfaced to the caller rather
 * than silently falling back to HMAP — a broken key should be visible in
 * the ingestion log, not masked forever by degraded-but-working behavior.
 */

import { log } from "./index";
import { storage } from "./storage";

const HMAP_WISHLIST_URL = "https://howmanyareplaying.com/api/wishlist";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_BASE = "https://api.igdb.com/v4";

// Steam's identifier under IGDB's `external_game_source` (current) and
// `category` (deprecated 2025+) enums. Both use the same integer, 1.
// See HMAP lessons.md: using the deprecated `category` field alone once
// caused a 0/199 match failure — always filter on external_game_source,
// keep `category` only as a defensive fallback in the row extractor.
const IGDB_STEAM_EXTERNAL_SOURCE = 1;

const IGDB_BATCH_SIZE = 200;
const IGDB_INTER_BATCH_SLEEP_MS = 300;
const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;
const REFRESH_SAFETY_MS = 60_000; // refresh token 60s before expiry

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HmapWishlistRow {
  appid?: number;
  igdb_id?: number | null;
  igdb_hype?: number | null;
}
interface HmapWishlistResponse {
  data?: HmapWishlistRow[];
}

/** True once both Twitch credentials are saved in Settings. */
export function directIgdbAvailable(): boolean {
  return !!storage.getSetting("twitch_client_id")?.value && !!storage.getSetting("twitch_client_secret")?.value;
}

// ---------------------------------------------------------------------------
// Twitch Client Credentials token cache
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

function readTwitchCreds(): { clientId: string; clientSecret: string } {
  const clientId = storage.getSetting("twitch_client_id")?.value || "";
  const clientSecret = storage.getSetting("twitch_client_secret")?.value || "";
  if (!clientId || !clientSecret) {
    throw new Error("twitch_client_id and twitch_client_secret settings must both be set");
  }
  return { clientId, clientSecret };
}

async function mintTwitchToken(): Promise<string> {
  // Read creds fresh on every mint (not cached at module load) so a
  // Settings-page save takes effect on the very next ingestion run,
  // with no server restart required.
  const { clientId, clientSecret } = readTwitchCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Never log response body here — it's the token endpoint and could
    // echo back credential-adjacent error detail. Status code only.
    throw new Error(`Twitch token mint failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("Twitch token response missing access_token/expires_in");
  }

  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - REFRESH_SAFETY_MS };
  log(`[igdb] minted new Twitch app access token (expires in ${json.expires_in}s)`, "igdb");
  return cachedToken.token;
}

async function getTwitchToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  return mintTwitchToken();
}

function invalidateTwitchToken(): void {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Direct IGDB /games calls
// ---------------------------------------------------------------------------

function backoffFor429(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const cap = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * cap);
}

interface IgdbGameRow {
  id: number;
  hypes?: number;
  summary?: string;
  screenshots?: { image_id?: string }[];
  videos?: { video_id?: string }[];
  external_games?: { uid?: string; category?: number; external_game_source?: number }[];
}

async function postGames(queryText: string, retriedAfter401 = false, retryCount429 = 0): Promise<IgdbGameRow[]> {
  const token = await getTwitchToken();
  const { clientId } = readTwitchCreds();

  const res = await fetch(`${IGDB_BASE}/games`, {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: queryText,
  });

  if (res.status === 401 && !retriedAfter401) {
    log("[igdb] 401 from IGDB — invalidating twitch token and retrying once", "igdb");
    invalidateTwitchToken();
    return postGames(queryText, true, retryCount429);
  }

  if (res.status === 429) {
    if (retryCount429 >= MAX_429_RETRIES) {
      throw new Error(`IGDB POST /games failed: HTTP 429 after ${MAX_429_RETRIES} retries`);
    }
    const attempt = retryCount429 + 1;
    const delayMs = backoffFor429(res, attempt);
    log(`[igdb] 429 from IGDB — attempt ${attempt}/${MAX_429_RETRIES}, waiting ${delayMs}ms`, "igdb");
    await sleep(delayMs);
    return postGames(queryText, retriedAfter401, attempt);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`IGDB POST /games failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("IGDB POST /games returned non-array response");
  return json as IgdbGameRow[];
}

async function fetchOneBatchDirect(appids: number[]): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const quoted = appids.map((id) => `"${id}"`).join(",");
  // Narrow field list — only what SignalPulse's hype column needs.
  const query =
    `fields id,hypes,external_games.uid,external_games.category,external_games.external_game_source;` +
    ` where external_games.uid = (${quoted}) & external_games.external_game_source = ${IGDB_STEAM_EXTERNAL_SOURCE};` +
    ` limit 500;`;

  const rows = await postGames(query);
  const map = new Map<number, { igdbId: number; hypeScore: number | null }>();

  for (const row of rows) {
    // Match on external_game_source (current) OR category (deprecated
    // fallback) — see module header, the 0/199 lesson is load-bearing.
    const externalSteam = (row.external_games || []).find(
      (x) => (x.external_game_source === IGDB_STEAM_EXTERNAL_SOURCE || x.category === IGDB_STEAM_EXTERNAL_SOURCE) && x.uid,
    );
    if (!externalSteam?.uid) continue;
    const appid = Number.parseInt(externalSteam.uid, 10);
    if (!Number.isInteger(appid)) continue;

    map.set(appid, {
      igdbId: row.id,
      hypeScore: Number.isFinite(row.hypes as number) ? (row.hypes as number) : null,
    });
  }
  return map;
}

async function fetchIgdbHypesDirect(steamAppids: number[]): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const uniq = Array.from(new Set(steamAppids.filter((n) => Number.isInteger(n))));
  const result = new Map<number, { igdbId: number; hypeScore: number | null }>();
  if (uniq.length === 0) return result;

  let batchIndex = 0;
  for (let i = 0; i < uniq.length; i += IGDB_BATCH_SIZE) {
    if (batchIndex > 0) await sleep(IGDB_INTER_BATCH_SLEEP_MS);
    const batch = uniq.slice(i, i + IGDB_BATCH_SIZE);
    const partial = await fetchOneBatchDirect(batch);
    for (const [appid, meta] of Array.from(partial)) result.set(appid, meta);
    batchIndex += 1;
  }

  log(`[igdb] direct IGDB call matched ${result.size}/${uniq.length} Saber appids`, "igdb");
  return result;
}

// ---------------------------------------------------------------------------
// HMAP proxy fallback (pre-v4.2 behavior, used only when creds are unset)
// ---------------------------------------------------------------------------

async function fetchIgdbHypesViaHmap(steamAppids: number[]): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const wanted = new Set(steamAppids.filter((n) => Number.isInteger(n)));
  const result = new Map<number, { igdbId: number; hypeScore: number | null }>();
  if (wanted.size === 0) return result;

  const res = await fetch(HMAP_WISHLIST_URL, {
    headers: { "User-Agent": "signalpulse.saber/igdb-hype-via-hmap" },
  });
  if (!res.ok) throw new Error(`howmanyareplaying wishlist API responded HTTP ${res.status}`);

  const json = (await res.json()) as HmapWishlistResponse;
  const rows = json?.data;
  if (!Array.isArray(rows)) throw new Error("howmanyareplaying wishlist API returned unexpected response shape");

  for (const row of rows) {
    if (typeof row.appid !== "number" || !wanted.has(row.appid)) continue;
    if (!Number.isInteger(row.igdb_id)) continue;
    result.set(row.appid, {
      igdbId: row.igdb_id as number,
      hypeScore: Number.isFinite(row.igdb_hype as number) ? (row.igdb_hype as number) : null,
    });
  }

  log(
    `[igdb] (fallback: no Twitch credentials set) matched ${result.size}/${wanted.size} Saber appids against howmanyareplaying's Top 200 (${rows.length} rows fetched)`,
    "igdb",
  );
  return result;
}

// ---------------------------------------------------------------------------
// Media fetch (Saber Steam CCU Leaderboard PDP — v1.0, 2026-09-08)
//
// Ported field list from howmanyareplaying/backend/src/services/igdbApi.js
// (screenshots.image_id, videos.video_id, summary). Same
// external_game_source=1 Steam-match rule as the hype fetcher above. No
// HMAP fallback — media is a PDP enhancement, not core leaderboard data, so
// when direct IGDB isn't configured this just returns an empty map and the
// PDP renders without the media carousel.
// ---------------------------------------------------------------------------

export interface IgdbMediaResult {
  igdbId: number;
  summary: string | null;
  screenshotIds: string[];
  videoIds: string[];
}

async function fetchOneMediaBatchDirect(appids: number[]): Promise<Map<number, IgdbMediaResult>> {
  const quoted = appids.map((id) => `"${id}"`).join(",");
  const query =
    `fields id,summary,screenshots.image_id,videos.video_id,external_games.uid,external_games.category,external_games.external_game_source;` +
    ` where external_games.uid = (${quoted}) & external_games.external_game_source = ${IGDB_STEAM_EXTERNAL_SOURCE};` +
    ` limit 500;`;

  const rows = await postGames(query);
  const map = new Map<number, IgdbMediaResult>();

  for (const row of rows) {
    const externalSteam = (row.external_games || []).find(
      (x) => (x.external_game_source === IGDB_STEAM_EXTERNAL_SOURCE || x.category === IGDB_STEAM_EXTERNAL_SOURCE) && x.uid,
    );
    if (!externalSteam?.uid) continue;
    const appid = Number.parseInt(externalSteam.uid, 10);
    if (!Number.isInteger(appid)) continue;

    map.set(appid, {
      igdbId: row.id,
      summary: typeof row.summary === "string" && row.summary.trim() ? row.summary : null,
      screenshotIds: (row.screenshots || []).map((s) => s.image_id).filter((x): x is string => !!x),
      videoIds: (row.videos || []).map((v) => v.video_id).filter((x): x is string => !!x),
    });
  }
  return map;
}

/**
 * Fetch IGDB media (summary + screenshot/video ids) for a list of Steam
 * appids. Returns a Map<steamAppid, IgdbMediaResult>; an appid absent from
 * the map means no IGDB/Steam match was found, or direct IGDB credentials
 * are not configured. Batches at IGDB_BATCH_SIZE like the hype fetcher.
 */
export async function fetchIgdbMediaBySteamAppids(steamAppids: number[]): Promise<Map<number, IgdbMediaResult>> {
  const uniq = Array.from(new Set(steamAppids.filter((n) => Number.isInteger(n))));
  const result = new Map<number, IgdbMediaResult>();
  if (uniq.length === 0) return result;

  if (!directIgdbAvailable()) {
    log("[igdb] media fetch skipped — twitch_client_id/twitch_client_secret not configured", "igdb");
    return result;
  }

  let batchIndex = 0;
  for (let i = 0; i < uniq.length; i += IGDB_BATCH_SIZE) {
    if (batchIndex > 0) await sleep(IGDB_INTER_BATCH_SLEEP_MS);
    const batch = uniq.slice(i, i + IGDB_BATCH_SIZE);
    const partial = await fetchOneMediaBatchDirect(batch);
    for (const [appid, meta] of Array.from(partial)) result.set(appid, meta);
    batchIndex += 1;
  }

  log(`[igdb] media fetch matched ${result.size}/${uniq.length} Saber appids`, "igdb");
  return result;
}

// ---------------------------------------------------------------------------
// Public entry point — unchanged signature, callers in ingestion.ts untouched
// ---------------------------------------------------------------------------

/**
 * Fetch IGDB Hype scores for a list of Steam appids.
 *
 * Returns a Map<steamAppid, { igdbId, hypeScore }>. An appid ABSENT from
 * the map means no IGDB/Steam match was found (caller should persist
 * igdbId=null, hypeScore=null). An appid present with `hypeScore: null`
 * means IGDB has the title but no hype data for it yet — render as "—",
 * never 0.
 *
 * Uses direct IGDB calls (all leaderboard titles, any rank) when
 * `twitch_client_id`/`twitch_client_secret` are set in Settings;
 * otherwise falls back to howmanyareplaying.com's public Top 200 list.
 */
export async function fetchIgdbHypesBySteamAppids(
  steamAppids: number[],
): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  if (directIgdbAvailable()) {
    return fetchIgdbHypesDirect(steamAppids);
  }
  return fetchIgdbHypesViaHmap(steamAppids);
}

// ---------------------------------------------------------------------------
// PDP-facing media accessor + daily cache refresh (v1.0, 2026-09-08)
// ---------------------------------------------------------------------------

const IGDB_MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refreshed daily, see startCcuPollScheduler's sibling cron

/**
 * Cache-first IGDB media for a single product's PDP. Serves the cached row
 * when it's <24h old; otherwise fetches live (single-appid batch), upserts
 * the cache, and returns the fresh result. Returns null when the product
 * has no steamAppId, or when no IGDB/Steam match exists at all (cache row
 * absent AND live fetch found nothing) -- the PDP renders without a media
 * carousel in that case rather than showing stale/fabricated data.
 */
export async function getIgdbMediaForProduct(productId: number): Promise<IgdbMediaResult | null> {
  const cached = storage.getIgdbMediaCache(productId);
  if (cached) {
    const age = Date.now() - new Date(cached.updatedAt).getTime();
    if (age < IGDB_MEDIA_CACHE_TTL_MS) {
      return {
        igdbId: cached.igdbId ?? 0,
        summary: cached.summary,
        screenshotIds: cached.screenshotIds ? JSON.parse(cached.screenshotIds) : [],
        videoIds: cached.videoIds ? JSON.parse(cached.videoIds) : [],
      };
    }
  }

  const product = storage.getProduct(productId);
  const appid = product?.steamAppId ? Number.parseInt(product.steamAppId, 10) : null;
  if (!appid || !Number.isInteger(appid)) {
    return cached
      ? { igdbId: cached.igdbId ?? 0, summary: cached.summary, screenshotIds: cached.screenshotIds ? JSON.parse(cached.screenshotIds) : [], videoIds: cached.videoIds ? JSON.parse(cached.videoIds) : [] }
      : null;
  }

  try {
    const fresh = (await fetchIgdbMediaBySteamAppids([appid])).get(appid);
    const nowIso = new Date().toISOString();
    if (fresh) {
      storage.upsertIgdbMediaCache({
        productId,
        igdbId: fresh.igdbId,
        summary: fresh.summary,
        screenshotIds: JSON.stringify(fresh.screenshotIds),
        videoIds: JSON.stringify(fresh.videoIds),
        updatedAt: nowIso,
      });
      return fresh;
    }
    // No live match -- fall back to whatever's cached (even if stale) rather
    // than blanking out a previously-working carousel on a transient miss.
    if (cached) {
      return { igdbId: cached.igdbId ?? 0, summary: cached.summary, screenshotIds: cached.screenshotIds ? JSON.parse(cached.screenshotIds) : [], videoIds: cached.videoIds ? JSON.parse(cached.videoIds) : [] };
    }
    return null;
  } catch (err) {
    log(`[igdb] getIgdbMediaForProduct(${productId}) live fetch failed: ${(err as Error).message}`, "igdb");
    if (cached) {
      return { igdbId: cached.igdbId ?? 0, summary: cached.summary, screenshotIds: cached.screenshotIds ? JSON.parse(cached.screenshotIds) : [], videoIds: cached.videoIds ? JSON.parse(cached.videoIds) : [] };
    }
    return null;
  }
}

/**
 * Daily bulk refresh for every CCU-eligible Saber title's IGDB media cache.
 * Wired into server startup on its own 24h interval (see index.ts) --
 * separate from the 60-minute CCU poll since media/summary text changes
 * far less often than live player counts.
 */
export async function refreshIgdbMediaForCcuTitles(): Promise<void> {
  const { getCcuEligibleSteamTitles } = await import("./leaderboards");
  const titles = getCcuEligibleSteamTitles();
  const appidToProduct = new Map<number, number>();
  for (const p of titles) {
    const appid = p.steamAppId ? Number.parseInt(p.steamAppId, 10) : null;
    if (appid && Number.isInteger(appid)) appidToProduct.set(appid, p.id);
  }
  if (appidToProduct.size === 0) return;

  const mediaMap = await fetchIgdbMediaBySteamAppids(Array.from(appidToProduct.keys()));
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const [appid, productId] of Array.from(appidToProduct)) {
    const media = mediaMap.get(appid);
    if (!media) continue;
    storage.upsertIgdbMediaCache({
      productId,
      igdbId: media.igdbId,
      summary: media.summary,
      screenshotIds: JSON.stringify(media.screenshotIds),
      videoIds: JSON.stringify(media.videoIds),
      updatedAt: nowIso,
    });
    updated += 1;
  }
  log(`[igdb] daily media refresh: updated ${updated}/${appidToProduct.size} Saber CCU title(s)`, "igdb");
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
// Runs once every 24h, offset from the top-of-hour CCU poll so the two never
// contend for the same tick. Fires once immediately after a short startup
// delay so a fresh deploy doesn't wait a full day for its first media pull.
let igdbMediaRefreshInterval: ReturnType<typeof setInterval> | null = null;

export function startIgdbMediaRefreshScheduler(): void {
  if (igdbMediaRefreshInterval) return;
  log("Saber Steam CCU IGDB media refresh scheduler started (every 24h)", "igdb");

  setTimeout(() => {
    refreshIgdbMediaForCcuTitles().catch((err) => log(`[igdb] initial media refresh failed: ${(err as Error).message}`, "igdb"));
  }, 60 * 1000);

  igdbMediaRefreshInterval = setInterval(() => {
    refreshIgdbMediaForCcuTitles().catch((err) => log(`[igdb] scheduled media refresh failed: ${(err as Error).message}`, "igdb"));
  }, 24 * 60 * 60 * 1000);
}

export function stopIgdbMediaRefreshScheduler(): void {
  if (igdbMediaRefreshInterval) {
    clearInterval(igdbMediaRefreshInterval);
    igdbMediaRefreshInterval = null;
    log("Saber Steam CCU IGDB media refresh scheduler stopped", "igdb");
  }
}
