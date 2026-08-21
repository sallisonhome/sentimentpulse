// Wishlist manual-insert merge — SignalPulse port.
//
// Why this exists
// ---------------
// Steam's public wishlist ranking endpoint —
//   https://store.steampowered.com/search/results/?filter=popularwishlist
// silently filters out certain appids that ARE in the public wishlist
// ranking. Verified 2026-08-21 on the hmap project: appid 1551980
// (Clive Barker's Hellraiser: Revival) is absent from every page (0..5200)
// across every cc (US/DE/JP/GB/IN/AU/CN/RU) with ignore_preferences=1 and
// cookieless requests, while SteamDB and the Steam client's public
// wishlist ranking view both show it at #155. Steam's search endpoint is
// the outlier; the site is the ground truth.
//
// The hmap fix ships in howmanyareplaying/backend/src/services/
// wishlistManualMerge.js. This file is a byte-for-byte-compatible TS port
// so that IF a Saber-published pre-release title ever gets Steam-filtered
// the same way Hellraiser was, we can add it to the JSON list and its
// rank stays stable on the Wishlist Leaderboard rather than silently
// going null.
//
// Differences from the hmap module
// --------------------------------
// - hmap merges into a full leaderboard array (top ~200 by rank). We just
//   need a Map<appid, rank> keyed by the Saber pre-release title's appid,
//   so mergeIntoRankMap() is the primary export, not a list-merger.
// - Last-known-rank lookup here reads steam_wishlist_rank_daily (our own
//   history), not wishlist_snapshots. Callers pass a lookup function so
//   the module stays DB-agnostic and unit-testable without a DB.
// - The DROP DETECTOR (ranked in the last N days, missing today with no
//   manual entry) is the ingestion result's user-visible signal — even if
//   no manual entry exists yet, a drop shows up in the run message. This
//   is SignalPulse-specific: hmap's leaderboard is public and drops there
//   just remove a row; here the Saber title still exists and we want to
//   know when Steam is hiding it.
//
// Design principles carried over from hmap
// ----------------------------------------
// 1. Steam-native rank always wins. If Steam returned the appid, we don't
//    touch it — that's a recovery event.
// 2. Last-observed rank is the injection point. seed_rank in the JSON is
//    only used when we've NEVER observed the appid.
// 3. Pure function. No DB, no network, no filesystem in mergeIntoRankMap.
//    loadManualAppids() reads a file; that's the only I/O.
// 4. Observable. Returns a metrics object with per-appid detail so the
//    ingestion result can surface exactly which titles were fallback-
//    ranked and which are silently dropped from Steam.

// esbuild bundles the JSON directly into dist/index.cjs at build time
// (loader: json). This avoids runtime filesystem lookups and the
// dist/ vs server/ path skew that would otherwise break the require. In
// tsc mode moduleResolution=bundler + resolveJsonModule handles it
// natively.
import manualAppidsData from "./data/wishlist-manual-appids.json";

export interface ManualAppidEntry {
  appid: number;
  name: string;
  seed_rank: number | null;
  logo: string | null;
}

export interface LastKnownRank {
  rank: number;
  captured_at: Date | string;
}

export interface MergeMetrics {
  /** How many entries were declared in the JSON. */
  manual_configured: number;
  /** How many were applied as a fallback rank this run (Steam omitted them). */
  manual_inserts_active: number;
  /** How many recovered — Steam returned them, so no fallback needed. */
  manual_inserts_recovered: number;
  /** Of the actives, how many had a last-known snapshot older than staleWarningDays. */
  manual_inserts_stale: number;
  manual_inserted_appids: number[];
  manual_recovered_appids: number[];
  /** Per-appid detail so the ingestion-result message can name what was fallback-ranked. */
  inserts_detail: Array<{
    appid: number;
    name: string;
    fallback_rank: number;
    source: "last_known" | "seed_rank" | "none";
  }>;
}

export interface MergeResult {
  /** Rank overrides to apply after the Steam scan, keyed by appid. */
  rankOverrides: Map<number, number>;
  metrics: MergeMetrics;
}

/**
 * Return the parsed `appids` array from the bundled JSON, or an empty
 * array if the file is empty/malformed. Async signature preserved for
 * API parity with hmap's loadManualAppids() so a future consolidation
 * into a shared package is trivial — and to allow future file-based
 * hot-reload without a caller-side signature change.
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

export interface MergeIntoRankMapOptions {
  manualEntries: ManualAppidEntry[];
  lastKnownRanks: Map<number, LastKnownRank>;
  /** The appids Steam returned this run (both fast path and extended scan). */
  steamAppidSet: Set<number>;
  /** Threshold in days above which an insert with an old last-known snapshot counts as stale. */
  staleWarningDays?: number;
}

/**
 * Compute the rank overrides to apply to `rankByAppid` for manual entries.
 * Pure function — no I/O.
 *
 * The scheduler (ingestSteamWishlistRank) should:
 *   1. Run fast-path + extended scan to build rankByAppid.
 *   2. Call loadManualAppids() and build steamAppidSet from rankByAppid.keys().
 *   3. Load lastKnownRanks via storage.getLatestSteamWishlistRankByAppid(...).
 *   4. Call mergeIntoRankMap() to get rankOverrides.
 *   5. Apply overrides to rankByAppid ONLY where rankByAppid.get(appid) is
 *      undefined (Steam-native rank wins per principle #1).
 *   6. Persist rankByAppid to steam_wishlist_rank_daily.
 */
export function mergeIntoRankMap(opts: MergeIntoRankMapOptions): MergeResult {
  const manualEntries = Array.isArray(opts.manualEntries) ? opts.manualEntries : [];
  const lastKnownRanks =
    opts.lastKnownRanks instanceof Map ? opts.lastKnownRanks : new Map<number, LastKnownRank>();
  const steamAppidSet = opts.steamAppidSet instanceof Set ? opts.steamAppidSet : new Set<number>();
  const staleWarningDays = Number.isFinite(opts.staleWarningDays)
    ? (opts.staleWarningDays as number)
    : 30;

  const rankOverrides = new Map<number, number>();
  const recovered: number[] = [];
  const stale: number[] = [];
  const insertsDetail: MergeMetrics["inserts_detail"] = [];
  const now = Date.now();
  const staleCutoffMs = staleWarningDays * 24 * 60 * 60 * 1000;

  for (const entry of manualEntries) {
    if (steamAppidSet.has(entry.appid)) {
      recovered.push(entry.appid);
      continue;
    }
    const lastKnown = lastKnownRanks.get(entry.appid) ?? null;
    let fallbackRank: number;
    let source: "last_known" | "seed_rank" | "none";
    if (lastKnown && Number.isInteger(lastKnown.rank) && lastKnown.rank > 0) {
      fallbackRank = lastKnown.rank;
      source = "last_known";
      const capturedAtMs = new Date(lastKnown.captured_at).getTime();
      if (Number.isFinite(capturedAtMs) && now - capturedAtMs > staleCutoffMs) {
        stale.push(entry.appid);
      }
    } else if (entry.seed_rank !== null) {
      fallbackRank = entry.seed_rank;
      source = "seed_rank";
    } else {
      // No last-known AND no seed_rank — nothing meaningful to stamp.
      // Skip; the daily row will still be rank=null and the drop detector
      // (in ingestion.ts) will still surface it in the run message.
      insertsDetail.push({
        appid: entry.appid,
        name: entry.name,
        fallback_rank: 0,
        source: "none",
      });
      continue;
    }
    rankOverrides.set(entry.appid, fallbackRank);
    insertsDetail.push({
      appid: entry.appid,
      name: entry.name,
      fallback_rank: fallbackRank,
      source,
    });
  }

  return {
    rankOverrides,
    metrics: {
      manual_configured: manualEntries.length,
      manual_inserts_active: rankOverrides.size,
      manual_inserts_recovered: recovered.length,
      manual_inserts_stale: stale.length,
      manual_inserted_appids: Array.from(rankOverrides.keys()),
      manual_recovered_appids: recovered,
      inserts_detail: insertsDetail,
    },
  };
}

/**
 * Given the list of tracked appids, the ranks Steam returned this run, and
 * a lookup for whether each appid had a rank in the last N days, return the
 * set of appids that have "dropped" — present in recent history but missing
 * from today's fetch AND not covered by a manual fallback.
 *
 * The caller decides what to do with the result (log, alert, notify). This
 * function is pure and side-effect-free.
 */
export interface DropDetectorOptions {
  trackedAppids: number[];
  steamAppidSet: Set<number>;
  /** Appids that already have a manual fallback applied — excluded from drops. */
  manualCoveredAppids: Set<number>;
  /**
   * For each tracked appid, the number of days in the lookback window on
   * which we have a non-null rank. Callers build this from
   * storage.countRankedDaysInWindow(appid, days).
   */
  rankedDaysInWindow: Map<number, number>;
  /** Minimum ranked-days-in-window to count as "recently ranked". Default 1. */
  minRankedDaysForDrop?: number;
}

export interface DetectedDrop {
  appid: number;
  ranked_days_in_window: number;
}

export function detectDrops(opts: DropDetectorOptions): DetectedDrop[] {
  const minRanked = Number.isFinite(opts.minRankedDaysForDrop)
    ? (opts.minRankedDaysForDrop as number)
    : 1;
  const drops: DetectedDrop[] = [];
  for (const appid of opts.trackedAppids) {
    if (opts.steamAppidSet.has(appid)) continue;
    if (opts.manualCoveredAppids.has(appid)) continue;
    const rankedDays = opts.rankedDaysInWindow.get(appid) ?? 0;
    if (rankedDays >= minRanked) {
      drops.push({ appid, ranked_days_in_window: rankedDays });
    }
  }
  return drops;
}
