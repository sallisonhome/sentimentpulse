/**
 * "Top 5 Steam crossover games" widget — v5 algorithm ported verbatim from
 * howmanyareplaying/backend/src/services/steamApi.js (fetchRelatedGames +
 * helpers, lines 360-597), replicated exactly per explicit user approval
 * ("Yes, replicate exactly" — SteamHunters mechanism + monthly cadence).
 *
 * Pipeline (LOCKED, validated across 14 titles / 8+ genres in HMAP):
 *   1. Fetch ~20 "more like this" candidates from Valve's own store recs.
 *   2. Enrich each via SteamHunters (achievement-hunter panel size,
 *      completion count, achievement count, tags).
 *   3. Gate: playerCount >= 5000 AND achievementCount >= 5.
 *   4. Score: (completed/players) / sqrt(achievements) * log(players + 1).
 *   5. Sort desc, franchise-dedupe (46 patterns, keep highest per franchise).
 *   6. MMR re-rank (LAMBDA=0.8, full-tag Jaccard) to pick a diverse top 5.
 *
 * Persisted into related_games_steamhunters (top 5, 1-based `position`) by
 * the monthly precompute job below — PDP reads never hit Valve/SteamHunters
 * live, matching HMAP's GameDetail read path.
 */

import { log } from "./index";
import { storage } from "./storage";
import { getCcuEligibleSteamTitles } from "./leaderboards";
import type { InsertRelatedGamesSteamHunters } from "@shared/schema";

const RELATED_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const RELATED_MORELIKE_BASE = "https://store.steampowered.com/recommended/morelike/app/";
const RELATED_STEAMHUNTERS_BASE = "https://steamhunters.com/api/apps/";
const RELATED_MMR_LAMBDA = 0.8;
const RELATED_TOP_N = 5;
const RELATED_MIN_PLAYERS = 5000;
const RELATED_MIN_ACHIEVEMENTS = 5;
const RELATED_SH_CONCURRENCY = 8;
const RELATED_DELAY_BETWEEN_TITLES_MS = 500;
const RELATED_HEADER_IMAGE = (appid: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 46-entry franchise dedupe list — byte-for-byte ported from HMAP's
// RELATED_FRANCHISE_PATTERNS so franchise-collision behavior matches
// exactly (e.g. two CoD entries never both survive dedupe).
const RELATED_FRANCHISE_PATTERNS: { key: string; re: RegExp }[] = [
  { key: "call_of_duty", re: /\bcall of duty\b|\bcod\b/i },
  { key: "battlefield", re: /\bbattlefield\b/i },
  { key: "rainbow_six", re: /rainbow six|\br6\b/i },
  { key: "counter_strike", re: /counter[- ]?strike|\bcs\s*[:2go]/i },
  { key: "apex", re: /\bapex legends\b/i },
  { key: "destiny", re: /\bdestiny\b/i },
  { key: "halo", re: /\bhalo\b/i },
  { key: "battlefront", re: /battlefront/i },
  { key: "pubg", re: /\bpubg\b|playerunknown/i },
  { key: "fortnite", re: /\bfortnite\b/i },
  { key: "the_finals", re: /\bthe finals\b/i },
  { key: "overwatch", re: /\boverwatch\b/i },
  { key: "hunt_showdown", re: /\bhunt:? showdown\b/i },
  { key: "valorant", re: /\bvalorant\b/i },
  { key: "left_4_dead", re: /left 4 dead|\bl4d\b/i },
  { key: "team_fortress", re: /team fortress|\btf2\b/i },
  { key: "titanfall", re: /titanfall/i },
  { key: "far_cry", re: /far cry/i },
  { key: "insurgency", re: /insurgency/i },
  { key: "squad", re: /\bsquad\b/i },
  { key: "arma", re: /\barma\b/i },
  { key: "dayz", re: /\bdayz\b/i },
  { key: "rust", re: /^rust$|\brust\b/i },
  { key: "tarkov", re: /escape from tarkov|tarkov/i },
  { key: "gta", re: /grand theft auto|\bgta\b/i },
  { key: "witcher", re: /\bwitcher\b/i },
  { key: "cyberpunk", re: /\bcyberpunk\b/i },
  { key: "elden_ring", re: /elden ring/i },
  { key: "dark_souls", re: /dark souls/i },
  { key: "sekiro", re: /\bsekiro\b/i },
  { key: "skyrim", re: /\bskyrim\b|elder scrolls/i },
  { key: "fallout", re: /\bfallout\b/i },
  { key: "stardew", re: /stardew valley/i },
  { key: "terraria", re: /\bterraria\b/i },
  { key: "minecraft", re: /\bminecraft\b/i },
  { key: "hades", re: /^hades( ii)?$|\bhades\b/i },
  { key: "civilization", re: /\bcivilization\b|\bciv\b/i },
  { key: "cities_skylines", re: /cities:?\s*skylines/i },
  { key: "forza", re: /\bforza\b/i },
  { key: "helldivers", re: /\bhelldivers\b/i },
  { key: "valheim", re: /\bvalheim\b/i },
  { key: "dota", re: /\bdota\s*2?\b/i },
  { key: "league_of_legends", re: /league of legends/i },
  { key: "total_war", re: /total war/i },
  { key: "ark", re: /\bark:? survival/i },
];

export function _franchiseKey(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const p of RELATED_FRANCHISE_PATTERNS) if (p.re.test(name)) return p.key;
  return null;
}

interface SteamHuntersApp {
  name?: string;
  playerCount?: number;
  playersCompletedCount?: number;
  achievementCount?: number;
  tags?: { tagId: number; name: string }[];
  error?: unknown;
}

export function _rawScore(sh: SteamHuntersApp | null | undefined): { score: number; reason: string } {
  const pc = sh?.playerCount || 0;
  const cc = sh?.playersCompletedCount || 0;
  const ac = sh?.achievementCount || 0;
  if (pc < RELATED_MIN_PLAYERS) return { score: -1, reason: "insufficient_panel" };
  if (ac < RELATED_MIN_ACHIEVEMENTS) return { score: -1, reason: ac === 0 ? "no_achievements" : "degenerate_achievements" };
  const rate = cc / pc;
  return { score: (rate / Math.sqrt(ac)) * Math.log(pc + 1), reason: "ok" };
}

export function _jaccard(a: Set<number>, b: Set<number>): number {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of Array.from(a)) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface ScoredCandidate {
  appid: number;
  name: string;
  playerCount: number;
  rawScore: number;
  tagSet: Set<number>;
  tagNames: string[];
}

export function _dedupeFranchise(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Set<string>();
  const kept: ScoredCandidate[] = [];
  for (const c of candidates) {
    const k = _franchiseKey(c.name);
    if (k === null) {
      kept.push(c);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(c);
  }
  return kept;
}

export function _mmrSelect(candidates: ScoredCandidate[], topN: number, lambda: number): ScoredCandidate[] {
  if (candidates.length === 0) return [];
  const selected = [candidates[0]];
  const remaining = candidates.slice(1);
  while (selected.length < topN && remaining.length > 0) {
    let bestIdx = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxJac = 0;
      for (const s of selected) {
        const j = _jaccard(c.tagSet, s.tagSet);
        if (j > maxJac) maxJac = j;
      }
      const adjusted = c.rawScore * (1 - lambda * maxJac);
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }
    const [pick] = remaining.splice(bestIdx, 1);
    selected.push(pick);
  }
  return selected;
}

async function fetchMoreLikeAppids(appid: number): Promise<number[]> {
  const url = `${RELATED_MORELIKE_BASE}${appid}/render/?query=&start=0&count=20`;
  const res = await fetch(url, { headers: { "User-Agent": RELATED_UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`morelike ${appid} => HTTP ${res.status}`);
  const body = await res.text();
  let html = body;
  try {
    const j = JSON.parse(body);
    if (j.results_html) html = j.results_html;
  } catch {
    // body wasn't JSON — use raw HTML as-is (matches HMAP's fallback).
  }
  const ids = new Set<number>();
  const re = /data-ds-appid="([\d,]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const first = m[1].split(",")[0].trim();
    const n = parseInt(first, 10);
    if (Number.isFinite(n) && n !== appid) ids.add(n);
  }
  return Array.from(ids);
}

async function fetchSteamHuntersApp(appid: number): Promise<SteamHuntersApp | null> {
  const url = `${RELATED_STEAMHUNTERS_BASE}${appid}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": RELATED_UA, Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as SteamHuntersApp;
  } catch (err) {
    log(`[ccu-related] fetchSteamHuntersApp(${appid}) failed: ${(err as Error).message}`, "ccu-related");
    return null;
  }
}

export interface RelatedGamePick {
  appid: number;
  name: string;
  headerImage: string;
  playerCount: number;
  tags: string[];
}

/**
 * Top 5 Steam "crossover" games for `appid`, via Valve morelike +
 * SteamHunters achievement-completion scoring. Returns [] on any upstream
 * failure or when nothing clears the gate — callers should clear stale
 * picks rather than leave old data if this returns [].
 */
export async function fetchRelatedGames(appid: number): Promise<RelatedGamePick[]> {
  let candidateIds: number[];
  try {
    candidateIds = await fetchMoreLikeAppids(appid);
  } catch (err) {
    log(`[ccu-related] fetchRelatedGames(${appid}) morelike failed: ${(err as Error).message}`, "ccu-related");
    return [];
  }
  if (candidateIds.length === 0) return [];

  const scored: ScoredCandidate[] = [];
  for (let i = 0; i < candidateIds.length; i += RELATED_SH_CONCURRENCY) {
    const batch = candidateIds.slice(i, i + RELATED_SH_CONCURRENCY);
    const shBatch = await Promise.all(batch.map(fetchSteamHuntersApp));
    for (let j = 0; j < batch.length; j++) {
      const sh = shBatch[j];
      if (!sh || sh.error) continue;
      const s = _rawScore(sh);
      if (s.score <= 0) continue;
      scored.push({
        appid: batch[j],
        name: sh.name || `App ${batch[j]}`,
        playerCount: sh.playerCount ?? 0,
        rawScore: s.score,
        tagSet: new Set((sh.tags || []).map((t) => t.tagId)),
        tagNames: (sh.tags || []).map((t) => t.name),
      });
    }
  }

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.rawScore - a.rawScore);
  const kept = _dedupeFranchise(scored);
  const picks = _mmrSelect(kept, RELATED_TOP_N, RELATED_MMR_LAMBDA);

  return picks.map((r) => ({
    appid: r.appid,
    name: r.name,
    headerImage: RELATED_HEADER_IMAGE(r.appid),
    playerCount: r.playerCount,
    tags: r.tagNames.slice(0, 5),
  }));
}

/** Cache-only read for the PDP -- never hits Valve/SteamHunters live. */
export function getRelatedGamesSteamHunters(productId: number) {
  return storage.getRelatedGamesSteamHunters(productId).map((row) => ({
    position: row.position,
    appid: row.relatedAppid,
    name: row.relatedName,
    headerImage: row.headerImage,
    playerCount: row.playerCount,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
  }));
}

/**
 * Monthly precompute for every CCU-eligible Saber title. Scheduled at
 * `0 10 1 * *` UTC (mirrors HMAP's pollRelatedGames.js cadence exactly —
 * see server/index.ts). Per-title transactional swap: a title whose fetch
 * fails keeps its previous picks; a title that fetches successfully but
 * scores nothing gets its stale picks cleared (matches HMAP's "picks.length
 * > 0 ? processed++ : skipped++" plus unconditional DELETE-then-maybe-INSERT).
 */
// Module-private in-flight guard, kept alongside the flag it protects
// (ES module bindings can't be reassigned from an importing module, so
// the guard lives here rather than as an exported mutable `let`).
let relatedGamesBackfillInFlight = false;

export async function pollRelatedGamesSteamHunters(): Promise<{ processed: number; skipped: number }> {
  const startMs = Date.now();
  storage.upsertRelatedGamesSteamHuntersMeta({ lastRefreshStartedAt: new Date().toISOString(), titlesProcessed: 0, titlesSkipped: 0 });

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
      const picks = await fetchRelatedGames(appid);
      const nowIso = new Date().toISOString();
      const rows: InsertRelatedGamesSteamHunters[] = picks.map((p, i) => ({
        productId: product.id,
        position: i + 1,
        relatedAppid: p.appid,
        relatedName: p.name,
        headerImage: p.headerImage,
        playerCount: p.playerCount,
        tags: JSON.stringify(p.tags),
        computedAt: nowIso,
      }));
      storage.replaceRelatedGamesSteamHunters(product.id, rows);
      if (picks.length > 0) processed += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      log(`[ccu-related] productId=${product.id} appid=${appid} failed: ${(err as Error).message}`, "ccu-related");
    }

    await sleep(RELATED_DELAY_BETWEEN_TITLES_MS);
  }

  // First day of next month at 10:00 UTC — same formula as HMAP's nextRefreshAt().
  const now = new Date();
  const nextRefreshAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 10, 0, 0)).toISOString();

  storage.upsertRelatedGamesSteamHuntersMeta({
    lastRefreshCompletedAt: new Date().toISOString(),
    nextRefreshAt,
    titlesProcessed: processed,
    titlesSkipped: skipped,
  });

  const durationSec = Math.round((Date.now() - startMs) / 1000);
  log(`[ccu-related] monthly precompute done in ${durationSec}s — processed=${processed} skipped=${skipped}`, "ccu-related");
  return { processed, skipped };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────
// `0 10 1 * *` UTC (1st of month, 10:00 UTC = 6am ET during EDT) — checked
// once per hour via the same wall-clock-tick idiom as ccu-poll.ts, since
// SignalPulse has no cron-expression library dependency.
let relatedPollInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredMonthKey: string | null = null;

export function startRelatedGamesScheduler(): void {
  if (relatedPollInterval) return;
  log("Saber Steam CCU related-games scheduler started (1st of month, 10:00 UTC)", "ccu-related");

  relatedPollInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCDate() !== 1 || now.getUTCHours() !== 10) return;
    const monthKey = now.toISOString().slice(0, 7); // yyyy-mm
    if (monthKey === lastFiredMonthKey) return;
    lastFiredMonthKey = monthKey;
    pollRelatedGamesSteamHunters().catch((err) => log(`[ccu-related] unhandled error: ${(err as Error).message}`, "ccu-related"));
  }, 60 * 60 * 1000);
}

export function stopRelatedGamesScheduler(): void {
  if (relatedPollInterval) {
    clearInterval(relatedPollInterval);
    relatedPollInterval = null;
    log("Saber Steam CCU related-games scheduler stopped", "ccu-related");
  }
}

// ─── Manual trigger (2026-09-08) ────────────────────────────────────────────
// Ops-token-gated one-off run for POST /api/ccu/related/backfill (see
// server/saber-auth.ts OPS_TOKEN_PATHS). The automatic scheduler above is an
// in-process setInterval with no catch-up if a deploy restarts the process
// during its exact 1st-of-month/10:00-UTC check window, so this exists to
// (a) populate the surface immediately instead of waiting for the next
// natural window, and (b) let an operator recover a missed month on demand.
// Runs the exact same pollRelatedGamesSteamHunters() pipeline -- no separate
// code path to drift from the scheduled one.
export async function triggerRelatedGamesBackfill(): Promise<
  | { ok: true; processed: number; skipped: number }
  | { ok: false; alreadyRunning: true }
> {
  if (relatedGamesBackfillInFlight) {
    return { ok: false, alreadyRunning: true };
  }
  relatedGamesBackfillInFlight = true;
  try {
    const { processed, skipped } = await pollRelatedGamesSteamHunters();
    return { ok: true, processed, skipped };
  } finally {
    relatedGamesBackfillInFlight = false;
  }
}
