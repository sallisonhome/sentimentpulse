// Wishlist manual-insert allowlist + drop detector — SignalPulse.
//
// Why this exists
// ---------------
// Steam's public wishlist ranking endpoint silently filters out certain
// appids that ARE in the public wishlist ranking. Verified 2026-08-21 on
// the hmap project: appid 1551980 (Clive Barker's Hellraiser: Revival)
// is absent from every page (0..5200) across every cc with
// ignore_preferences=1 and cookieless requests, while SteamDB and the
// Steam client's public wishlist ranking view both show it publicly
// ranked.
//
// This module is now narrow in scope after the 2026-08-21 hmap-source-
// of-truth refactor:
//
//   - loadManualAppids() reads the shipped JSON (via esbuild's json
//     loader, inlined into dist/index.cjs at build time) and returns
//     the allowlist of appids we'll accept a fallback rank for. Each
//     entry may include a seed_rank used only as a last-resort fallback
//     when hmap is unreachable AND SignalPulse has never observed a
//     rank locally. See hmap-source-of-truth.ts for the resolution flow.
//
//   - detectDrops() is the ingestion result's user-visible signal for
//     titles Steam is silently hiding that are NOT covered by the
//     manual allowlist. Ranked in the last N days but missing today
//     with no manual entry → surfaces in the run message so we notice
//     new Steam-filtered appids promptly.
//
// The rank-merge logic itself now lives in hmap-source-of-truth.ts
// because it has to consult hmap before it can decide.

import manualAppidsData from "./data/wishlist-manual-appids.json";

export interface ManualAppidEntry {
  appid: number;
  name: string;
  seed_rank: number | null;
  logo: string | null;
}

/**
 * Return the parsed `appids` array from the bundled JSON. Async signature
 * preserved for future hot-reload without a caller-side signature change.
 */
export async function loadManualAppids(): Promise<ManualAppidEntry[]> {
  const parsed = manualAppidsData as { appids?: unknown };
  if (!Array.isArray(parsed.appids)) return [];
  return parsed.appids
    .filter(
      (e: unknown): e is { appid: number } =>
        typeof e === "object" &&
        e !== null &&
        Number.isInteger((e as { appid?: unknown }).appid) &&
        (e as { appid: number }).appid > 0,
    )
    .map((e: Record<string, unknown>) => ({
      appid: e.appid as number,
      name: typeof e.name === "string" ? e.name : `appid ${e.appid}`,
      seed_rank:
        Number.isInteger(e.seed_rank) && (e.seed_rank as number) > 0
          ? (e.seed_rank as number)
          : null,
      logo: typeof e.logo === "string" ? e.logo : null,
    }));
}

export interface DropDetectorOptions {
  trackedAppids: number[];
  steamAppidSet: Set<number>;
  manualCoveredAppids: Set<number>;
  /** Map<appid, count of days in the last N with non-null rank>. */
  rankedDaysInWindow: Map<number, number>;
  /** Minimum ranked-days-in-window for an appid to count as a drop. Default 1. */
  minRankedDaysForDrop?: number;
}

export interface DetectedDrop {
  appid: number;
  ranked_days_in_window: number;
}

/**
 * Return the list of tracked appids that are missing from Steam's response
 * this run AND are NOT covered by the manual allowlist AND were ranked at
 * least `minRankedDaysForDrop` times in the recent window. These are the
 * candidates for "Steam started filtering this — investigate."
 *
 * Pure function; no DB / network / FS.
 */
export function detectDrops(opts: DropDetectorOptions): DetectedDrop[] {
  const {
    trackedAppids,
    steamAppidSet,
    manualCoveredAppids,
    rankedDaysInWindow,
    minRankedDaysForDrop = 1,
  } = opts;
  const drops: DetectedDrop[] = [];
  for (const appid of trackedAppids) {
    if (steamAppidSet.has(appid)) continue;
    if (manualCoveredAppids.has(appid)) continue;
    const ranked = rankedDaysInWindow.get(appid) ?? 0;
    if (ranked < minRankedDaysForDrop) continue;
    drops.push({ appid, ranked_days_in_window: ranked });
  }
  return drops;
}
