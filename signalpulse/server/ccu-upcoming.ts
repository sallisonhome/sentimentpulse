/**
 * "Popular Upcoming" widget (v1.0, 2026-09-09) — related UNRELEASED Steam
 * titles for a CCU PDP. Distinct from ccu-related.ts's "Top 5 Steam
 * Crossover Games" (already-released titles, Valve morelike HTML scrape +
 * SteamHunters scoring) — this feature surfaces titles that are related
 * but haven't launched yet, so there's no player/achievement data to score
 * against. Instead it uses Valve's own relevance ranking directly.
 *
 * Source: Steam Web API IStoreQueryService/MoreLikeThis/v1, official and
 * key-gated (same steam_api_key as the CCU leaderboard). Two undocumented
 * behaviors discovered and verified live 2026-09-09 (see lessons.md):
 *   - The endpoint silently returns `{"response":{}}` (HTTP 200, no error)
 *     unless `input_json.context` is populated, even with a valid key.
 *   - `filters.coming_soon_only: true` scopes results to unreleased titles;
 *     each returned item carries `release.is_coming_soon` plus either
 *     `release.steam_release_date` (unix seconds) or a
 *     `release.custom_release_date_message` ("Coming soon", "To be
 *     announced", etc.) — never both.
 *
 * Reuses ccu-related.ts's franchise-dedupe (`_franchiseKey`) so the same
 * title never appears twice under different sequel/edition names, and
 * reuses steam-header-image.ts's `fetchHeaderImage` for real header art
 * (some titles live on hashed Akamai asset paths that a synthesized
 * cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg URL 404s on
 * — same root cause already fixed for crossover games in v3.14 / PR #35).
 *
 * Persisted into related_games_upcoming (top 5, 1-based `position`) by the
 * monthly precompute job below — PDP reads never hit the Steam Web API
 * live, matching the crossover-games read path.
 */

import { log } from "./index";
import { storage } from "./storage";
import { getCcuEligibleSteamTitles } from "./leaderboards";
import { fetchHeaderImage } from "./steam-header-image";
import { _franchiseKey } from "./ccu-related";
import type { InsertRelatedGamesUpcoming } from "@shared/schema";

const MORE_LIKE_THIS_URL = "https://api.steampowered.com/IStoreQueryService/MoreLikeThis/v1/";
const UPCOMING_CANDIDATE_COUNT = 20; // headroom for franchise-dedupe before taking the top N
const UPCOMING_TOP_N = 5;
const UPCOMING_DELAY_BETWEEN_TITLES_MS = 500;
// Last-resort fallback only -- see steam-header-image.ts v3.14 / ccu-related.ts.
const UPCOMING_HEADER_IMAGE = (appid: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
const UPCOMING_HEADER_IMAGE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MoreLikeThisStoreItem {
  appid?: number;
  id?: number;
  name?: string;
  release?: {
    is_coming_soon?: boolean;
    steam_release_date?: number; // unix seconds
    custom_release_date_message?: string;
  };
}

interface MoreLikeThisResponse {
  response?: {
    store_items?: MoreLikeThisStoreItem[];
  };
}

/** Human-readable release label, honestly nullable rather than guessed. */
function releaseDisplayFor(release: MoreLikeThisStoreItem["release"]): string {
  if (!release) return "TBA";
  if (typeof release.steam_release_date === "number" && release.steam_release_date > 0) {
    return new Date(release.steam_release_date * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  if (release.custom_release_date_message) return release.custom_release_date_message;
  return "TBA";
}

/** Up to UPCOMING_CANDIDATE_COUNT unreleased titles related to `appid`, Valve's own relevance order. */
async function fetchMoreLikeThisUpcoming(
  appid: number,
): Promise<{ appid: number; name: string; releaseDisplay: string }[]> {
  const apiKey = storage.getSetting("steam_api_key")?.value;
  if (!apiKey) throw new Error("steam_api_key not configured");

  const inputJson = JSON.stringify({
    context: { language: "english", country_code: "US", elanguage: 0 },
    item_id: { appid },
    count: UPCOMING_CANDIDATE_COUNT,
    filters: { coming_soon_only: true },
    data_request: { include_basic_info: true, include_release: true },
  });
  const url = `${MORE_LIKE_THIS_URL}?key=${encodeURIComponent(apiKey)}&input_json=${encodeURIComponent(inputJson)}`;

  const res = await fetch(url, { headers: { "User-Agent": "signalpulse.saber/popular-upcoming" } });
  if (!res.ok) throw new Error(`MoreLikeThis responded HTTP ${res.status}`);
  const json = (await res.json()) as MoreLikeThisResponse;
  const items = json?.response?.store_items;
  if (!Array.isArray(items)) return [];

  const out: { appid: number; name: string; releaseDisplay: string }[] = [];
  for (const item of items) {
    const itemAppid = item.appid ?? item.id;
    if (!itemAppid || !item.name) continue;
    out.push({ appid: itemAppid, name: item.name, releaseDisplay: releaseDisplayFor(item.release) });
  }
  return out;
}

export interface UpcomingGamePick {
  appid: number;
  name: string;
  headerImage: string;
  releaseDisplay: string;
}

/**
 * Top 5 unreleased Steam titles related to `appid`, via Valve's official
 * MoreLikeThis + coming_soon_only. Returns [] on any upstream failure or
 * when nothing comes back — callers should clear stale picks rather than
 * leave old data if this returns [].
 */
export async function fetchPopularUpcoming(appid: number): Promise<UpcomingGamePick[]> {
  let candidates: { appid: number; name: string; releaseDisplay: string }[];
  try {
    candidates = await fetchMoreLikeThisUpcoming(appid);
  } catch (err) {
    log(`[ccu-upcoming] fetchPopularUpcoming(${appid}) MoreLikeThis failed: ${(err as Error).message}`, "ccu-upcoming");
    return [];
  }
  if (candidates.length === 0) return [];

  // Franchise-dedupe reuses ccu-related.ts's 46-pattern table (_franchiseKey)
  // so the same title never shows up twice across the crossover + upcoming
  // sections under a sequel/edition alias. Preserves Valve's own relevance
  // order (the candidates array order) -- no extra scoring needed here.
  const seenFranchises = new Set<string>();
  const deduped: typeof candidates = [];
  for (const c of candidates) {
    const k = _franchiseKey(c.name);
    if (k !== null) {
      if (seenFranchises.has(k)) continue;
      seenFranchises.add(k);
    }
    deduped.push(c);
  }
  const picks = deduped.slice(0, UPCOMING_TOP_N);

  const results: UpcomingGamePick[] = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    let headerImage: string;
    try {
      headerImage = (await fetchHeaderImage(p.appid)) ?? UPCOMING_HEADER_IMAGE(p.appid);
    } catch (err) {
      log(`[ccu-upcoming] fetchHeaderImage(${p.appid}) failed, using synthesized URL: ${(err as Error).message}`, "ccu-upcoming");
      headerImage = UPCOMING_HEADER_IMAGE(p.appid);
    }
    results.push({ appid: p.appid, name: p.name, headerImage, releaseDisplay: p.releaseDisplay });
    if (i < picks.length - 1) await sleep(UPCOMING_HEADER_IMAGE_DELAY_MS);
  }
  return results;
}

/** Cache-only read for the PDP -- never hits the Steam Web API live. */
export function getPopularUpcoming(productId: number) {
  return storage.getRelatedGamesUpcoming(productId).map((row) => ({
    position: row.position,
    appid: row.relatedAppid,
    name: row.relatedName,
    headerImage: row.headerImage,
    releaseDisplay: row.releaseDisplay,
  }));
}

/**
 * Monthly precompute for every CCU-eligible Saber title. Scheduled at
 * `0 10 1 * *` UTC, same wall-clock-tick idiom as ccu-related.ts. Per-title
 * transactional swap: a title whose fetch fails keeps its previous picks;
 * a title that fetches successfully but yields nothing gets its stale
 * picks cleared.
 */
let upcomingBackfillInFlight = false;

export async function pollPopularUpcoming(): Promise<{ processed: number; skipped: number }> {
  const startMs = Date.now();
  storage.upsertRelatedGamesUpcomingMeta({ lastRefreshStartedAt: new Date().toISOString(), titlesProcessed: 0, titlesSkipped: 0 });

  const titles = getCcuEligibleSteamTitles();
  let processed = 0;
  let skipped = 0;

  for (const product of titles) {
    const appid = product.steamAppId ? Number.parseInt(product.steamAppId, 10) : null;
    if (!appid || !Number.isInteger(appid)) {
      skipped += 1;
      continue;
    }

    try {
      const picks = await fetchPopularUpcoming(appid);
      const nowIso = new Date().toISOString();
      const rows: InsertRelatedGamesUpcoming[] = picks.map((p, i) => ({
        productId: product.id,
        position: i + 1,
        relatedAppid: p.appid,
        relatedName: p.name,
        headerImage: p.headerImage,
        releaseDisplay: p.releaseDisplay,
        computedAt: nowIso,
      }));
      storage.replaceRelatedGamesUpcoming(product.id, rows);
      if (picks.length > 0) processed += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      log(`[ccu-upcoming] productId=${product.id} appid=${appid} failed: ${(err as Error).message}`, "ccu-upcoming");
    }

    await sleep(UPCOMING_DELAY_BETWEEN_TITLES_MS);
  }

  // First day of next month at 10:00 UTC — same formula as ccu-related.ts.
  const now = new Date();
  const nextRefreshAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 10, 0, 0)).toISOString();

  storage.upsertRelatedGamesUpcomingMeta({
    lastRefreshCompletedAt: new Date().toISOString(),
    nextRefreshAt,
    titlesProcessed: processed,
    titlesSkipped: skipped,
  });

  const durationSec = Math.round((Date.now() - startMs) / 1000);
  log(`[ccu-upcoming] monthly precompute done in ${durationSec}s — processed=${processed} skipped=${skipped}`, "ccu-upcoming");
  return { processed, skipped };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
let upcomingPollInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredMonthKey: string | null = null;

export function startPopularUpcomingScheduler(): void {
  if (upcomingPollInterval) return;
  log("Saber Steam CCU popular-upcoming scheduler started (1st of month, 10:00 UTC)", "ccu-upcoming");

  upcomingPollInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCDate() !== 1 || now.getUTCHours() !== 10) return;
    const monthKey = now.toISOString().slice(0, 7); // yyyy-mm
    if (monthKey === lastFiredMonthKey) return;
    lastFiredMonthKey = monthKey;
    pollPopularUpcoming().catch((err) => log(`[ccu-upcoming] unhandled error: ${(err as Error).message}`, "ccu-upcoming"));
  }, 60 * 60 * 1000);
}

export function stopPopularUpcomingScheduler(): void {
  if (upcomingPollInterval) {
    clearInterval(upcomingPollInterval);
    upcomingPollInterval = null;
    log("Saber Steam CCU popular-upcoming scheduler stopped", "ccu-upcoming");
  }
}

// ─── Manual trigger ──────────────────────────────────────────────────────
// Ops-token-gated one-off run for POST /api/ccu/popular-upcoming/backfill
// (see server/saber-auth.ts OPS_TOKEN_PATHS) — mirrors
// triggerRelatedGamesBackfill in ccu-related.ts exactly, so an operator can
// populate the surface immediately or recover a missed month on demand.
export async function triggerPopularUpcomingBackfill(): Promise<
  | { ok: true; processed: number; skipped: number }
  | { ok: false; alreadyRunning: true }
> {
  if (upcomingBackfillInFlight) {
    return { ok: false, alreadyRunning: true };
  }
  upcomingBackfillInFlight = true;
  try {
    const { processed, skipped } = await pollPopularUpcoming();
    return { ok: true, processed, skipped };
  } finally {
    upcomingBackfillInFlight = false;
  }
}
