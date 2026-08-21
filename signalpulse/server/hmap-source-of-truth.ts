// Source of truth for manually-covered wishlist ranks: howmanyareplaying.com.
//
// Why this exists (2026-08-21 — user directive after PR #18 merged):
//   Steam's popularwishlist endpoint silently omits some appids (verified:
//   1551980 Hellraiser, absent across every page 0..5200 and every cc).
//   Both hmap and SignalPulse maintain their own manual-insert JSON to
//   backfill these titles. If they diverge — even by 2 ranks — the two
//   surfaces (hmap public leaderboard vs SignalPulse Wishlist Leaderboard)
//   show different numbers for the same title. That's exactly what
//   started happening: hmap 157, SignalPulse seed 155.
//
// Design: hmap is the SINGLE SOURCE OF TRUTH for any appid where Steam's
// popularwishlist omits it. SignalPulse fetches hmap's public API during
// each ingestSteamWishlistRank() run and, for any manually-covered appid
// Steam didn't return, uses hmap's number. Local seed_rank / last-known
// is ONLY used if hmap is unreachable or missing the appid.
//
// This guarantees SignalPulse rank === hmap rank for these appids on
// every 02:00 UTC run, by construction. No drift possible unless the
// fetch fails, in which case the log will make that obvious.
//
// The hmap API surface consumed:
//   GET https://howmanyareplaying.com/api/wishlist
//   -> { data: [{ appid: number, rank: number, name: string, ... }], ... }
//   Verified 2026-08-21: 201 rows, all with integer appid + integer rank.

const HMAP_WISHLIST_URL = "https://howmanyareplaying.com/api/wishlist";
const FETCH_TIMEOUT_MS = 10_000;

export interface HmapRankRow {
  appid: number;
  rank: number;
  name: string;
}

export interface HmapFetchResult {
  ok: boolean;
  rows: HmapRankRow[];
  rankByAppid: Map<number, number>;
  generatedAt: string | null;
  error: string | null;
}

/**
 * Fetch hmap's wishlist API and return a { appid -> rank } map.
 *
 * Never throws. On any failure (timeout, non-2xx, malformed JSON, unexpected
 * shape) returns { ok: false, rows: [], rankByAppid: new Map(), error }.
 * The caller must fall through to local seed / last-known in that case.
 *
 * The `fetchImpl` parameter is only for unit tests.
 */
export async function fetchHmapWishlistRanks(
  fetchImpl: typeof fetch = fetch,
): Promise<HmapFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetchImpl(HMAP_WISHLIST_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "SignalPulse/1.0 (+wishlist-sync)" },
    });
    if (!res.ok) {
      return {
        ok: false,
        rows: [],
        rankByAppid: new Map(),
        generatedAt: null,
        error: `HTTP ${res.status}`,
      };
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { data?: unknown }).data)
    ) {
      return {
        ok: false,
        rows: [],
        rankByAppid: new Map(),
        generatedAt: null,
        error: "unexpected response shape (missing data[])",
      };
    }
    const raw = (body as { data: unknown[]; generated_at?: unknown }).data;
    const generatedAt =
      typeof (body as { generated_at?: unknown }).generated_at === "string"
        ? ((body as { generated_at: string }).generated_at)
        : null;

    const rows: HmapRankRow[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as { appid?: unknown; rank?: unknown; name?: unknown };
      if (!Number.isInteger(r.appid) || (r.appid as number) <= 0) continue;
      if (!Number.isInteger(r.rank) || (r.rank as number) <= 0) continue;
      rows.push({
        appid: r.appid as number,
        rank: r.rank as number,
        name: typeof r.name === "string" ? r.name : `appid ${r.appid}`,
      });
    }

    const rankByAppid = new Map<number, number>();
    for (const row of rows) rankByAppid.set(row.appid, row.rank);

    return { ok: true, rows, rankByAppid, generatedAt, error: null };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : String(err);
    return {
      ok: false,
      rows: [],
      rankByAppid: new Map(),
      generatedAt: null,
      error,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface HmapSyncOptions {
  hmapRankByAppid: Map<number, number>;
  hmapOk: boolean;
  manualAppids: number[];
  steamAppidSet: Set<number>;
  /** Local last-known rank per appid, for delta logging + last-resort fallback. */
  lastKnownRanks: Map<number, { rank: number; captured_at: string }>;
  /** Local seed_rank per appid — LAST-RESORT fallback only. */
  seedRankByAppid: Map<number, number | null>;
}

export interface HmapSyncEntry {
  appid: number;
  fallback_rank: number;
  source: "hmap" | "last_known" | "seed_rank" | "none";
  hmap_rank: number | null;
  local_rank: number | null;
  delta: number | null; // hmap_rank - local_rank when both known
}

export interface HmapSyncMetrics {
  manual_configured: number;
  hmap_ok: boolean;
  hmap_covered: number; // # of manual appids hmap knows about
  hmap_source_count: number; // # of appids where hmap won and was used
  last_known_source_count: number;
  seed_source_count: number;
  none_source_count: number;
  delta_nonzero_count: number; // # of appids where hmap disagreed with local last-known
  entries: HmapSyncEntry[];
}

/**
 * Given hmap's fetched ranks, decide the fallback rank for each
 * manually-covered appid that Steam did NOT return this run.
 *
 * Priority:
 *   1. hmap (if fetched successfully AND has this appid)
 *   2. local last-known
 *   3. local seed_rank
 *   4. none (log-only, no override applied)
 *
 * Steam-native rank always wins upstream — this function is only called
 * for the gap set. Delta logging fires whenever hmap disagrees with the
 * local last-known number, so any drift is visible in ingestion logs.
 */
export function resolveManualRanks(opts: HmapSyncOptions): {
  rankOverrides: Map<number, number>;
  metrics: HmapSyncMetrics;
} {
  const {
    hmapRankByAppid,
    hmapOk,
    manualAppids,
    steamAppidSet,
    lastKnownRanks,
    seedRankByAppid,
  } = opts;
  const rankOverrides = new Map<number, number>();
  const entries: HmapSyncEntry[] = [];

  let hmapSourceCount = 0;
  let lastKnownSourceCount = 0;
  let seedSourceCount = 0;
  let noneSourceCount = 0;
  let deltaNonzeroCount = 0;

  for (const appid of manualAppids) {
    // If Steam returned it, skip — Steam-native rank wins upstream.
    if (steamAppidSet.has(appid)) continue;

    const hmapRank = hmapRankByAppid.get(appid) ?? null;
    const lastKnown = lastKnownRanks.get(appid)?.rank ?? null;
    const seed = seedRankByAppid.get(appid) ?? null;

    let fallback: number | null = null;
    let source: HmapSyncEntry["source"] = "none";

    if (hmapOk && hmapRank !== null) {
      fallback = hmapRank;
      source = "hmap";
      hmapSourceCount++;
      if (lastKnown !== null && lastKnown !== hmapRank) deltaNonzeroCount++;
    } else if (lastKnown !== null) {
      fallback = lastKnown;
      source = "last_known";
      lastKnownSourceCount++;
    } else if (seed !== null) {
      fallback = seed;
      source = "seed_rank";
      seedSourceCount++;
    } else {
      noneSourceCount++;
    }

    if (fallback !== null) rankOverrides.set(appid, fallback);

    entries.push({
      appid,
      fallback_rank: fallback ?? 0,
      source,
      hmap_rank: hmapRank,
      local_rank: lastKnown,
      delta:
        hmapRank !== null && lastKnown !== null ? hmapRank - lastKnown : null,
    });
  }

  return {
    rankOverrides,
    metrics: {
      manual_configured: manualAppids.length,
      hmap_ok: hmapOk,
      hmap_covered: manualAppids.filter((a) => hmapRankByAppid.has(a)).length,
      hmap_source_count: hmapSourceCount,
      last_known_source_count: lastKnownSourceCount,
      seed_source_count: seedSourceCount,
      none_source_count: noneSourceCount,
      delta_nonzero_count: deltaNonzeroCount,
      entries,
    },
  };
}
