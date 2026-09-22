/**
 * Steam Demos leaderboard API.
 *
 * Route: GET /api/demos/leaderboard
 * Query: window=d7|d30|d90|m12|ltd (default d7, matches the established
 *          console-leaderboard / hmap wishlist-leaderboard convention)
 *        sort=top|new|reviews|rating|downloads|ccu|peak|release
 *        direction=asc|desc (metric/date sorts; default desc)
 *        genre=<exact broad Steam genre>
 *        limit=1..250 (default 50)
 *
 * Ranking:
 *   sort=downloads (default) -- resolved unitsMid for the requested window.
 *     Raw review estimates stay persisted unchanged. Observed concurrency
 *     minima are labeled separately, never presented as calibrated estimates.
 *   sort=ccu -- latest sampled concurrent-player count, not a live feed.
 *   sort=top|new -- the latest successful verified source snapshot,
 *     preserving Steam's order independently of estimates or CCU.
 * Coverage includes per-feed attempts/success/error and candidate counts.
 *
 * Deactivated demos are excluded except approved Saber lifetime actuals.
 * Current Steam feeds and current-CCU views remain available-demo only.
 * This is a tracked, sampled catalog, not every historical demo on Steam.
 */

import type { Express } from "express";
import { rawSqlite } from "./storage";
import { WINDOWS, type WindowKey } from "./signals/demos/estimator";
import { DEMO_FEED_LIMIT } from "./signals/demos/feeds";
import { loadDemoReviewSummaries, type DemoReviewSummary } from "./signals/demos/review-summary";
import { loadDemoCatalog } from "./signals/demos/catalog";
import { DEMO_CALIBRATION, DEMO_DOWNLOAD_MULTIPLIER, NON_SABER_DOWNLOAD_TRIAL, demoDownloadMultiplier, demoReviewEstimate, reconcileDemoDownloads } from "./signals/demos/download-consistency";

type DemoSort = "top" | "new" | "reviews" | "rating" | "downloads" | "ccu" | "peak" | "release";

interface DemoLeaderboardRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
  releaseDate: string | null;
  isSaberPublished: boolean;
  isArchived: boolean;
  reviewCountTotal: number | null;
  reviewDelta: number | null;
  unitsLow: number | null;
  unitsMid: number | null;
  unitsHigh: number | null;
  method: string | null;
  ccuCurrent: number | null;
  ccuAllTimePeak: number | null;
  ccuAsOf: string | null;
  sourceRank: number | null;
  reviewEstimate: number | null;
  isObservedMinimum: boolean;
  lifetimeModelBelowPeak: boolean;
  downloadMultiplier: number | null;
  calibrationMode: "non_saber_trial" | "actual";
  actualsAsOf: string | null;
  actualsStartDate: string | null;
  actualsEndDate: string | null;
  actualsStale: boolean;
  actualsRefreshFailed: boolean;
  steamReviews: DemoReviewSummary | null;
}

function loadLeaderboardRows(window: WindowKey, sort: DemoSort, direction: "asc" | "desc", genre: string, limit: number) {
  const reviewSummaries = loadDemoReviewSummaries();
  const actualRows = rawSqlite.prepare("SELECT * FROM demo_download_actuals WHERE window=? AND source='steamworks_downloads_report'").all(window) as any[];
  const actualByAppId = new Map(actualRows.map(row => [row.steam_app_id, row]));
  // Latest estimate row per demo for the requested window (there is at
  // most one per demo_title_id+window+as_of_date; take the newest
  // as_of_date if the estimator has run more than once historically).
  const estimateRows = rawSqlite
    .prepare(
      `SELECT e.demo_title_id, e.as_of_date, e.review_count_total, e.review_delta,
              e.units_low, e.units_mid, e.units_high, e.method
       FROM demo_window_estimates_daily e
       INNER JOIN (
         SELECT demo_title_id, MAX(as_of_date) as max_date
         FROM demo_window_estimates_daily
         WHERE window = ?
         GROUP BY demo_title_id
       ) latest ON latest.demo_title_id = e.demo_title_id AND latest.max_date = e.as_of_date
       WHERE e.window = ?`
    )
    .all(window, window) as Array<{
      demo_title_id: number; as_of_date: string; review_count_total: number | null;
      review_delta: number | null; units_low: number | null; units_mid: number | null;
      units_high: number | null; method: string;
    }>;
  const estimateByDemoId = new Map(estimateRows.map((r) => [r.demo_title_id, r]));
  const lifetimeEstimates = rawSqlite.prepare(`
    SELECT e.demo_title_id,e.units_mid,e.review_delta FROM demo_window_estimates_daily e
    JOIN (SELECT demo_title_id,MAX(as_of_date) date FROM demo_window_estimates_daily
          WHERE window='ltd' GROUP BY demo_title_id) latest
      ON latest.demo_title_id=e.demo_title_id AND latest.date=e.as_of_date
    WHERE e.window='ltd' AND e.method='review_delta_multiplier'
  `).all() as Array<{ demo_title_id: number; units_mid: number | null; review_delta: number | null }>;
  const lifetimeById = new Map(lifetimeEstimates.map(row => [row.demo_title_id, row]));

  const ccuRows = rawSqlite
    .prepare(
      `SELECT demo_title_id, MAX(peak_ccu) as all_time_peak
       FROM demo_ccu_daily_peaks GROUP BY demo_title_id`
    )
    .all() as Array<{ demo_title_id: number; all_time_peak: number }>;
  const ccuPeakByDemoId = new Map(ccuRows.map((r) => [r.demo_title_id, r.all_time_peak]));

  const latestSnapshotRows = rawSqlite
    .prepare(
      `SELECT s.demo_title_id, s.ccu, s.captured_at
       FROM demo_ccu_snapshots s
       INNER JOIN (
         SELECT demo_title_id, MAX(captured_at) as max_captured
         FROM demo_ccu_snapshots GROUP BY demo_title_id
       ) latest ON latest.demo_title_id = s.demo_title_id AND latest.max_captured = s.captured_at`
    )
    .all() as Array<{ demo_title_id: number; ccu: number; captured_at: string }>;
  const ccuCurrentByDemoId = new Map(latestSnapshotRows.map((r) => [r.demo_title_id, r]));

  const demos = loadDemoCatalog();
  const sourceRanks = new Map((rawSqlite.prepare(
    "SELECT demo_title_id,source_rank FROM demo_discovery_ranks WHERE feed=?"
  ).all(sort) as Array<{ demo_title_id: number; source_rank: number }>)
    .map(row => [row.demo_title_id, row.source_rank]));

  let asOfDate: string | null = null;
  const rows: DemoLeaderboardRow[] = demos
    .filter(d => d.is_active === 1 || window === "ltd")
    .filter(d => !["top","new","ccu"].includes(sort) || d.is_active === 1)
    .filter(d => (sort !== "top" && sort !== "new") || sourceRanks.has(d.id))
    .filter(d => !genre || (d.genre ?? "").split(", ").includes(genre))
    .map((d) => {
    const est = d.is_active === 1 ? estimateByDemoId.get(d.id) : undefined;
    const snap = ccuCurrentByDemoId.get(d.id);
    const saber = d.is_saber_published === 1;
    const lifetime = lifetimeById.get(d.id);
    // Never use legacy license-category "actuals" from the estimate table.
    const reviewEstimate = saber ? null : demoReviewEstimate(est?.review_delta ?? null,
      est?.method === "review_delta_multiplier" ? est.units_mid : null, "review_delta_multiplier", false);
    const actual = actualByAppId.get(d.steam_app_id);
    const actualValue = Number.isSafeInteger(actual?.downloads) && actual.downloads >= 0 ? actual.downloads : null;
    const dailyPeak = ccuPeakByDemoId.get(d.id);
    const observedPeak = d.is_active !== 1 || (dailyPeak == null && snap == null)
      ? null : Math.max(dailyPeak ?? 0, snap?.ccu ?? 0);
    const resolved = saber ? {
      unitsMid: actualValue, reviewEstimate: null, isObservedMinimum: false,
      lifetimeModelBelowPeak: false, method: actualValue === null ? null : "steamworks_actual",
    } : reconcileDemoDownloads({
      window, releaseDate: d.release_date, reviewEstimate,
      lifetimeReviewEstimate: lifetime ? demoReviewEstimate(lifetime.review_delta, lifetime.units_mid, "review_delta_multiplier", saber) : null,
      method: reviewEstimate == null ? null : "review_delta_multiplier", observedPeak,
    });
    if (est?.as_of_date && (!asOfDate || est.as_of_date > asOfDate)) asOfDate = est.as_of_date;
    return {
      id: d.id,
      steamAppId: d.steam_app_id,
      name: d.name,
      genre: d.genre,
      releaseDate: d.release_date,
      isSaberPublished: d.is_saber_published === 1,
      isArchived: d.is_active !== 1,
      reviewCountTotal: reviewSummaries.get(d.steam_app_id)?.total ?? est?.review_count_total ?? null,
      steamReviews: reviewSummaries.get(d.steam_app_id) ?? null,
      reviewDelta: est?.review_delta ?? null,
      unitsLow: null,
      unitsHigh: null,
      ...resolved,
      downloadMultiplier: saber ? null : demoDownloadMultiplier(false),
      calibrationMode: saber ? "actual" : "non_saber_trial",
      actualsAsOf: saber ? actual?.fetched_at ?? null : null,
      actualsStartDate: saber ? actual?.report_start_date ?? null : null,
      actualsEndDate: saber ? actual?.report_end_date ?? null : null,
      actualsStale: saber && (!actual?.fetched_at || Date.now() - Date.parse(actual.fetched_at) > 3 * 86400_000),
      actualsRefreshFailed: saber && !!actual?.last_error,
      ccuCurrent: d.is_active === 1 ? snap?.ccu ?? null : null,
      ccuAllTimePeak: observedPeak,
      ccuAsOf: d.is_active === 1 ? snap?.captured_at ?? null : null,
      sourceRank: sourceRanks.get(d.id) ?? null,
    };
  });

  if (sort === "top" || sort === "new") {
    rows.sort((a, b) => a.sourceRank! - b.sourceRank!);
  } else {
    const value = (row: DemoLeaderboardRow): number | string | null => sort === "reviews" ? row.reviewCountTotal
      : sort === "rating" ? row.steamReviews?.positivePercent ?? null
      : sort === "downloads" ? row.unitsMid : sort === "ccu" ? row.ccuCurrent
      : sort === "peak" ? row.ccuAllTimePeak : row.releaseDate;
    rows.sort((a, b) => {
      const av = value(a); const bv = value(b);
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
      const comparison = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
      return direction === "asc" ? comparison : -comparison;
    });
  }

  return { rows: rows.slice(0, limit), asOfDate, availableCount: rows.length };
}

export function registerDemosLeaderboardRoutes(app: Express) {
  app.get("/api/demos/leaderboard", (req, res) => {
    try {
      const window = ((req.query.window as string) || "d7") as WindowKey;
      const sort = ((req.query.sort as string) || "downloads").toLowerCase();
      const direction = ((req.query.direction as string) || "desc").toLowerCase();
      const genre = ((req.query.genre as string) || "").trim();
      const limitRaw = parseInt((req.query.limit as string) || "50", 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 250) : 50;

      if (!WINDOWS.includes(window)) return res.status(400).json({ error: "invalid window" });
      if (!["top","new","reviews","rating","downloads","ccu","peak","release"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      if (direction !== "asc" && direction !== "desc") return res.status(400).json({ error: "invalid direction" });

      const catalog = loadDemoCatalog();
      const genres = Array.from(new Set(catalog.flatMap(row => row.genre?.split(", ") ?? []))).sort();
      if (genre && !genres.includes(genre)) return res.status(400).json({ error: "invalid genre" });
      const { rows, asOfDate, availableCount } = loadLeaderboardRows(window, sort as DemoSort, direction, genre, limit);
      const feeds = rawSqlite.prepare(`SELECT feed,last_attempt_at AS lastAttemptAt,
        last_success_at AS lastSuccessAt,error,candidate_count AS candidateCount,
        eligible_count AS eligibleCount,total_matches AS totalMatches FROM demo_discovery_feeds`).all();
      res.json({
        window,
        sort,
        direction,
        genre: genre || null,
        genres,
        asOfDate,
        availableCount,
        coverage: { candidateLimitPerFeed: DEMO_FEED_LIMIT, feeds, completeSteamCatalog: false,
          trackedCount: catalog.length, availableCount: catalog.filter(d=>d.is_active===1).length,
          archivedCount: catalog.filter(d=>d.is_active!==1).length },
        multiplier: { ...DEMO_DOWNLOAD_MULTIPLIER, nonSaberTrial: NON_SABER_DOWNLOAD_TRIAL,
          note: "Saber: Steamworks demo Downloads by Region report. Non-Saber: user-selected review-delta trial; observed minima are not fitted estimates." },
        calibration: DEMO_CALIBRATION,
        count: rows.length,
        demos: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deactivated Saber demos (Toxic Commando, The Knightling, Bus Bound,
  // Painkiller) -- only lifetime actuals are retained on the leaderboard.
  app.get("/api/demos/saber-archive", (_req, res) => {
    try {
      const rows = rawSqlite
        .prepare(
          `SELECT steam_app_id, name, genre, is_active, deactivated_at
           FROM demo_titles WHERE is_saber_published = 1 ORDER BY name`
        )
        .all();
      res.json({ count: (rows as any[]).length, demos: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
