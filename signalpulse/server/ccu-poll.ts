/**
 * Saber Steam CCU Leaderboard — 60-minute poll job (v1.0, 2026-09-08).
 *
 * Ported approach from howmanyareplaying/backend/src/scheduler/pollLive.js,
 * scoped down to Saber's own released titles only (see
 * leaderboards.ts::getCcuEligibleSteamTitles — steamAppId set AND
 * releaseDate <= today, re-evaluated fresh on every poll so a title
 * flips into scope automatically the moment it releases, with no manual
 * registration step).
 *
 * Differs from howmanyareplaying's version in scope, not mechanism:
 *   - No top-100 leaderboard_cache rebuild, no watchlist-promotion logic,
 *     no peak-record windows, no SteamCharts retroactive backfill. Saber's
 *     leaderboard only ever has a handful of titles, always shown in full.
 *   - Global rank (GetGamesByConcurrentPlayers, top 100 by LIVE CCU) is
 *     fetched every poll purely to look up each Saber title's position, if
 *     any — per explicit user instruction ("current Steam ccu rank pulled
 *     from the Steam web api ... ordered from most to least ccu" governs
 *     row ORDER; global rank is a separate, honestly-nullable display
 *     value). Steam's API only ranks its own top ~100 games, so niche Saber
 *     titles will often have no match — stored as `globalRank: null` and
 *     must render as "unranked" on the frontend, never as a guessed value.
 *   - Row order for the leaderboard itself is CCU descending among Saber's
 *     own titles, independent of whether a global rank was found.
 *
 * Freshness: GetNumberOfCurrentPlayers (per-appid, no key needed) is called
 * for every Saber title and takes precedence over the top-100 list's
 * `concurrent_in_game` snapshot value when both are available — same
 * override rule as pollLive.js.
 */

import { storage } from "./storage";
import { log } from "./index";
import { getCcuEligibleSteamTitles } from "./leaderboards";

const MOST_PLAYED_URL = "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/?format=json";
const CURRENT_PLAYERS_BASE = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1";
const CURRENT_PLAYERS_BATCH_SIZE = 10;

interface SteamRankEntry {
  rank: number;
  appid: number;
  concurrent_in_game: number;
  peak_in_game: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Top ~100 Steam games sorted by live CCU, with each one's global rank. */
async function fetchTopGames(): Promise<SteamRankEntry[]> {
  const apiKey = storage.getSetting("steam_api_key")?.value;
  const url = apiKey ? `${MOST_PLAYED_URL}&key=${apiKey}` : MOST_PLAYED_URL;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GetGamesByConcurrentPlayers responded HTTP ${res.status}`);
  }
  const json = (await res.json()) as { response?: { ranks?: SteamRankEntry[] } };
  const ranks = json?.response?.ranks;
  if (!Array.isArray(ranks)) {
    throw new Error("GetGamesByConcurrentPlayers returned unexpected response shape");
  }
  return ranks;
}

/** Live player count for a single appid. Returns null on any failure. */
async function fetchGameCcu(appid: number): Promise<number | null> {
  try {
    const res = await fetch(`${CURRENT_PLAYERS_BASE}?appid=${appid}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: { player_count?: number } };
    const count = json?.response?.player_count;
    return typeof count === "number" && count >= 0 ? count : null;
  } catch (err) {
    log(`[ccu-poll] fetchGameCcu(${appid}) failed: ${(err as Error).message}`, "ccu-poll");
    return null;
  }
}

/** Batched (10 at a time) live CCU lookup — mirrors HMAP's fetchCurrentPlayers. */
async function fetchCurrentPlayersBatch(appids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  for (let i = 0; i < appids.length; i += CURRENT_PLAYERS_BATCH_SIZE) {
    const batch = appids.slice(i, i + CURRENT_PLAYERS_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(async (appid) => ({ appid, count: await fetchGameCcu(appid) })));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.count != null) {
        result.set(r.value.appid, r.value.count);
      }
    }
  }
  return result;
}

/**
 * Core poll — call every 60 minutes (see startCcuPollScheduler below).
 * 1. Fetch Steam's live top-100 (for global rank lookups).
 * 2. Fetch Saber's own eligible (released, steamAppId set) titles.
 * 3. Fetch fresh per-appid CCU for those titles (overrides top-100 snapshot value).
 * 4. Insert a ccu_snapshots_steam row per title (ccu + globalRank, nullable).
 * 5. Upsert today's daily peak (GREATEST-wins) per title.
 * 6. Record poll state for the frontend countdown timer.
 */
export async function pollSaberSteamCcu(): Promise<void> {
  const start = Date.now();
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  const titles = getCcuEligibleSteamTitles();
  if (titles.length === 0) {
    storage.upsertCcuPollState({ lastPolledAt: nowIso, lastPollResult: "success", titlesPolled: 0 });
    log("[ccu-poll] no eligible Saber Steam titles (none released with a steamAppId) — nothing to poll", "ccu-poll");
    return;
  }

  let globalRanks: Map<number, SteamRankEntry>;
  try {
    const ranks = await fetchTopGames();
    globalRanks = new Map(ranks.map((r) => [r.appid, r]));
  } catch (err) {
    const message = (err as Error).message;
    log(`[ccu-poll] fetchTopGames failed: ${message}`, "ccu-poll");
    storage.upsertCcuPollState({ lastPolledAt: nowIso, lastPollResult: `error: ${message}`, titlesPolled: 0 });
    return;
  }

  const appidToProduct = new Map<number, { id: number; title: string }>();
  for (const p of titles) {
    const appid = Number.parseInt(p.steamAppId as string, 10);
    if (Number.isInteger(appid)) appidToProduct.set(appid, { id: p.id, title: p.title });
  }
  const appids = Array.from(appidToProduct.keys());

  let currentPlayerMap: Map<number, number>;
  try {
    currentPlayerMap = await fetchCurrentPlayersBatch(appids);
  } catch (err) {
    const message = (err as Error).message;
    log(`[ccu-poll] fetchCurrentPlayersBatch failed: ${message}`, "ccu-poll");
    storage.upsertCcuPollState({ lastPolledAt: nowIso, lastPollResult: `error: ${message}`, titlesPolled: 0 });
    return;
  }

  let polled = 0;
  let skipped = 0;
  for (const [appid, product] of Array.from(appidToProduct)) {
    const rankEntry = globalRanks.get(appid);
    // Per-app endpoint takes precedence for freshness; top-100 list's
    // concurrent_in_game is the fallback when the per-app call failed.
    const ccu = currentPlayerMap.get(appid) ?? rankEntry?.concurrent_in_game;
    if (ccu == null) {
      skipped += 1;
      log(`[ccu-poll] no CCU reading for "${product.title}" (appid ${appid}) this poll — skipped`, "ccu-poll");
      continue;
    }
    const globalRank = rankEntry?.rank ?? null;
    storage.insertCcuSnapshot(product.id, ccu, nowIso, globalRank);
    storage.upsertDailyPeakCcu(product.id, today, ccu);
    polled += 1;
  }

  storage.upsertCcuPollState({ lastPolledAt: nowIso, lastPollResult: "success", titlesPolled: polled });
  log(
    `[ccu-poll] done in ${Date.now() - start}ms — ${polled}/${titles.length} Saber title(s) polled` +
      (skipped > 0 ? ` (${skipped} skipped, no CCU reading)` : ""),
    "ccu-poll",
  );
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
// Top of every UTC hour (":00"), matching howmanyareplaying's `0 * * * *`
// pollLive cadence exactly, ported to SignalPulse's existing 60s wall-clock
// tick + per-slot dedupe idiom (see amazon-cron.ts) rather than adding a new
// cron library dependency.
let ccuPollInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredHourKey: string | null = null;

export function startCcuPollScheduler(): void {
  if (ccuPollInterval) return; // idempotent
  log("Saber Steam CCU poll scheduler started (top of every UTC hour)", "ccu-poll");

  ccuPollInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCMinutes() !== 0) return;
    const hourKey = now.toISOString().slice(0, 13); // yyyy-mm-ddThh
    if (hourKey === lastFiredHourKey) return; // already fired this hour
    lastFiredHourKey = hourKey;
    pollSaberSteamCcu().catch((err) => log(`[ccu-poll] unhandled error: ${(err as Error).message}`, "ccu-poll"));
  }, 60_000);
}

export function stopCcuPollScheduler(): void {
  if (ccuPollInterval) {
    clearInterval(ccuPollInterval);
    ccuPollInterval = null;
    log("Saber Steam CCU poll scheduler stopped", "ccu-poll");
  }
}
