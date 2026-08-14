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
