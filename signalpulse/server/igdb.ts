/**
 * IGDB Hype Fetcher (Steam Leaderboards — Wishlist board)
 *
 * Ported from howmanyareplaying/backend/src/services/igdbApi.js +
 * twitchAuth.js, simplified to fetch ONLY the `hypes` field (IGDB's
 * pre-release follower count) — none of howmanyareplaying's About-block /
 * media-gallery / franchise fields are needed for the leaderboard's IGDB
 * Hype Score column.
 *
 * Two behavioral differences from the howmanyareplaying source, both
 * required by this app's architecture:
 *   1. Credentials come from `storage.getSetting("igdb_client_id" /
 *      "igdb_client_secret")` (the Settings page), NOT
 *      process.env.TWITCH_CLIENT_ID/SECRET — SignalPulse's credential
 *      story is DB-backed settings, not container env vars.
 *   2. IGDB and Twitch Helix share the same OAuth token endpoint and
 *      Client Credentials grant; we keep our own minimal token cache here
 *      rather than importing howmanyareplaying's twitchAuth.js module,
 *      since we only ever call IGDB (never Helix) from SignalPulse.
 */

import { storage } from "./storage";
import { log } from "./index";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_BASE = "https://api.igdb.com/v4";
const REFRESH_SAFETY_MS = 60_000; // refresh 60s before expiry

// Steam's identifier under IGDB's `external_game_source` enum (current).
// NOT the deprecated `category` field — IGDB stopped populating `category`
// on newer entries in 2025+ (confirmed during Phase 0 spike research).
const IGDB_STEAM_EXTERNAL_SOURCE = 1;

// Chunk size when there are more appids than IGDB will accept in one query.
// IGDB's hard cap is 500; 200 matches howmanyareplaying's convention and
// covers this leaderboard's <=20-title cap in a single batch.
const IGDB_BATCH_SIZE = 200;

// Inter-batch sleep — only paid between batches, so the common single-batch
// case (this leaderboard never exceeds 20 titles) pays zero pacing tax.
const IGDB_INTER_BATCH_SLEEP_MS = 300;

// 429 retry policy: Retry-After (seconds) honored verbatim when present;
// full-jitter exponential backoff fallback. Max 3 retries then propagate.
const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}

let cached: CachedToken | null = null;

function readCreds(): { clientId: string; clientSecret: string } {
  const clientId = storage.getSetting("igdb_client_id")?.value || "";
  const clientSecret = storage.getSetting("igdb_client_secret")?.value || "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "igdb_client_id and igdb_client_secret must be set in Settings > IGDB / Twitch before IGDB Hype ingestion can run",
    );
  }
  return { clientId, clientSecret };
}

async function mintToken(): Promise<string> {
  const { clientId, clientSecret } = readCreds();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twitch token mint failed: HTTP ${res.status} ${text}`);
  }

  const json = await res.json();
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("Twitch token response missing access_token/expires_in");
  }

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000 - REFRESH_SAFETY_MS,
  };
  log(`[igdb] minted new app access token (expires in ${json.expires_in}s)`, "igdb");
  return cached.token;
}

async function getTwitchToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  return mintToken();
}

/** Force-invalidate the cached token. Called on a 401 from IGDB. */
function invalidateToken(): void {
  cached = null;
}

function backoffFor429(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }
  const cap = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * cap);
}

interface IgdbGameRow {
  id: number;
  hypes?: number;
  external_games?: { uid?: string; external_game_source?: number }[];
}

async function postGames(
  queryText: string,
  retriedAfter401 = false,
  retryCount429 = 0,
): Promise<IgdbGameRow[]> {
  const token = await getTwitchToken();
  const { clientId } = readCreds();

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
    log("[igdb] 401 from IGDB — invalidating token and retrying once", "igdb");
    invalidateToken();
    return postGames(queryText, true, retryCount429);
  }

  if (res.status === 429) {
    if (retryCount429 >= MAX_429_RETRIES) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `IGDB POST /games failed: HTTP 429 after ${MAX_429_RETRIES} retries. ${text.slice(0, 200)}`,
      );
    }
    const attempt = retryCount429 + 1;
    const delayMs = backoffFor429(res, attempt);
    log(
      `[igdb] 429 from IGDB POST /games — attempt ${attempt}/${MAX_429_RETRIES}, waiting ${delayMs}ms`,
      "igdb",
    );
    await sleep(delayMs);
    return postGames(queryText, retriedAfter401, attempt);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`IGDB POST /games failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error("IGDB POST /games returned non-array response");
  }
  return json as IgdbGameRow[];
}

async function fetchOneBatch(
  appids: number[],
): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const quoted = appids.map((id) => `"${id}"`).join(",");
  const query =
    `fields id,hypes,external_games.uid,external_games.external_game_source;` +
    ` where external_games.uid = (${quoted}) & external_games.external_game_source = ${IGDB_STEAM_EXTERNAL_SOURCE};` +
    ` limit 500;`;

  const rows = await postGames(query);
  const map = new Map<number, { igdbId: number; hypeScore: number | null }>();

  for (const row of rows) {
    const externalSteam = (row.external_games || []).find(
      (x) => x.external_game_source === IGDB_STEAM_EXTERNAL_SOURCE && x.uid,
    );
    if (!externalSteam || !externalSteam.uid) continue;
    const appid = Number.parseInt(externalSteam.uid, 10);
    if (!Number.isInteger(appid)) continue;

    map.set(appid, {
      igdbId: row.id,
      hypeScore: Number.isFinite(row.hypes) ? (row.hypes as number) : null,
    });
  }

  return map;
}

/**
 * Fetch IGDB Hype scores for a list of Steam appids in one (or a small
 * number of) batched POST /games call(s).
 *
 * Returns a Map<steamAppid, { igdbId, hypeScore }>. An appid ABSENT from
 * the map means IGDB has no record at all for that Steam title (caller
 * should persist igdbId=null, hypeScore=null). An appid present with
 * `hypeScore: null` means IGDB has the title but no hype data yet —
 * render as "—", never 0.
 */
export async function fetchIgdbHypesBySteamAppids(
  steamAppids: number[],
): Promise<Map<number, { igdbId: number; hypeScore: number | null }>> {
  const uniq = Array.from(new Set(steamAppids.filter((n) => Number.isInteger(n))));
  if (uniq.length === 0) return new Map();

  const result = new Map<number, { igdbId: number; hypeScore: number | null }>();
  let batchIndex = 0;
  for (let i = 0; i < uniq.length; i += IGDB_BATCH_SIZE) {
    if (batchIndex > 0) await sleep(IGDB_INTER_BATCH_SLEEP_MS);
    const batch = uniq.slice(i, i + IGDB_BATCH_SIZE);
    const partial = await fetchOneBatch(batch);
    partial.forEach((meta, appid) => result.set(appid, meta));
    batchIndex += 1;
  }
  return result;
}
