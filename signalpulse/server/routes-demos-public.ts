/**
 * Public read-only Steam demos endpoints (HMAP rebroadcast contract).
 *
 * Routes (GET only; saber-auth exposes the /api/demos/public/ prefix as a
 * public read, rate-limited per IP with authenticated operators exempt):
 *   /api/demos/public/leaderboard          — top-N Steam demos (kind is fixed
 *                                            to "demo"; Friends Passes are
 *                                            never served here)
 *   /api/demos/public/titles/:appId         — public demo detail (PDP)
 *   /api/demos/public/titles/:appId/media   — IGDB media for the demo
 *
 * Design rules (advisor review 2026-10-22):
 *  - Responses are an EXPLICIT public allowlist. Anything not enumerated
 *    here (licenses, estimate internals, pass data, pipeline coverage,
 *    calibration config) must not be added casually.
 *  - Ranking happens over the COMPLETE filtered catalog before the top-N
 *    slice, with deterministic ties (name, then id).
 *  - Peak CCU is the observed, hourly-sampled peak inside the requested
 *    window: MAX of daily peaks and raw snapshots whose timestamps fall in
 *    the window. It is NOT Steam's chart peak and NOT the recent-24h
 *    figure. For ltd it equals the all-time observed peak.
 *  - Retired demos stay in metric views (marked), exactly like the
 *    authenticated leaderboard; top/new views stay availability-based.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { rawSqlite } from "./storage";
import { WINDOW_DAYS, WINDOWS, type WindowKey } from "./signals/demos/estimator";
import { loadDemoCatalog } from "./signals/demos/catalog";
import { loadDemoDetailSummary, loadDemoRowsForWindow, type DemoLeaderboardRow } from "./routes-demos-leaderboard";
import { loadDemoHistory } from "./signals/demos/history";
import { getDemoMedia } from "./signals/demos/media";
import { archivedSnapshot } from "./signals/demos/archive";
import { PASS_PLAYER_EVIDENCE } from "./signals/demos/pass-player-evidence";
import { NON_SABER_DOWNLOAD_TRIAL } from "./signals/demos/download-consistency";
import type { DemoDetail, DemoHistoryPoint, DemoRange } from "../shared/demo-detail";

const PUBLIC_SORTS = ["top", "new", "reviews", "rating", "downloads", "ccu", "peak", "release"] as const;
type PublicSort = (typeof PUBLIC_SORTS)[number];

// Mirrors publicLeaderboardLimiter in routes-console-leaderboards.ts: the
// per-IP budget for unauthenticated public reads. hmap's pass-through caches
// for 5 minutes, so per-visitor traffic here is far below the cap; the
// authenticated SPA never hits these paths as public reads.
const publicDemoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => Boolean((req as typeof req & { saberUser?: unknown }).saberUser),
  message: { error: "rate_limited", detail: "Too many requests, please try again shortly." },
});

/**
 * MAX observed CCU inside [windowStart, now] from daily peaks + raw
 * snapshots. windowStart null = lifetime (matches the all-time observed
 * peak: ccuAllTimePeak). Window bounds follow the estimator's convention
 * (windowStart = now - WINDOW_DAYS*86400; m12 = 365 days).
 */
function windowPeakByDemoId(window: WindowKey): Map<number, number> {
  const days = WINDOW_DAYS[window];
  const startIso = days === null ? null : new Date(Date.now() - days * 86400_000).toISOString();
  const startDate = startIso?.slice(0, 10) ?? null;
  const out = new Map<number, number>();
  const bump = (id: number, v: number) => out.set(id, Math.max(out.get(id) ?? 0, v));
  const peaks = rawSqlite
    .prepare(
      `SELECT demo_title_id, MAX(peak_ccu) AS peak FROM demo_ccu_daily_peaks
       WHERE ? IS NULL OR peak_date >= ? GROUP BY demo_title_id`
    )
    .all(startDate, startDate) as Array<{ demo_title_id: number; peak: number }>;
  for (const r of peaks) bump(r.demo_title_id, r.peak);
  const snaps = rawSqlite
    .prepare(
      `SELECT demo_title_id, MAX(ccu) AS peak FROM demo_ccu_snapshots
       WHERE ? IS NULL OR captured_at >= ? GROUP BY demo_title_id`
    )
    .all(startIso, startIso) as Array<{ demo_title_id: number; peak: number }>;
  for (const r of snaps) bump(r.demo_title_id, r.peak);
  return out;
}

/** Public-safe leaderboard row. Explicit allowlist — do not add fields that
 *  carry licenses, estimate internals, pass data or pipeline coverage. */
function publicLeaderboardRow(row: DemoLeaderboardRow, peakWindow: number | null) {
  return {
    steamAppId: row.steamAppId,
    name: row.name,
    genre: row.genre,
    releaseDate: row.releaseDate,
    releaseDateUnverified: row.releaseDateUnverified,
    isSaberPublished: row.isSaberPublished,
    isArchived: row.isArchived,
    retiredAt: row.retiredAt,
    downloads: {
      value: row.unitsMid ?? null,
      observedMinimum: row.isObservedMinimum,
      isSaberActual: row.isSaberPublished && row.unitsMid != null,
      asOf: row.isSaberPublished ? row.actualsAsOf : row.estimateAsOf,
      stale: row.isSaberPublished ? row.actualsStale : row.estimateStale,
    },
    reviews: {
      total: row.reviewCountTotal ?? null,
      positivePercent: row.steamReviews?.positivePercent ?? null,
    },
    ccu: {
      current: row.ccuCurrent ?? null,
      asOf: row.ccuAsOf ?? null,
      peakWindow,
      peakAllTime: row.ccuAllTimePeak ?? null,
    },
    sourceRank: row.sourceRank ?? null,
  };
}

type PublicRow = ReturnType<typeof publicLeaderboardRow> & { id: number; nameKey: string };

function sortValue(sort: PublicSort, r: PublicRow): number | string | null {
  switch (sort) {
    case "reviews": return r.reviews.total;
    case "rating": return r.reviews.positivePercent;
    case "downloads": return r.downloads.value;
    case "ccu": return r.ccu.current;
    case "peak": return r.ccu.peakWindow;
    case "release": return r.releaseDate;
    default: return null; // top/new use sourceRank below
  }
}

export function registerDemosPublicRoutes(app: Express) {
  app.get("/api/demos/public/leaderboard", publicDemoLimiter, (req, res) => {
    try {
      const window = String(req.query.window ?? "d7");
      const sort = String(req.query.sort ?? "downloads").toLowerCase() as PublicSort;
      const direction = String(req.query.direction ?? "desc").toLowerCase();
      const genre = String(req.query.genre ?? "").trim();
      const search = String(req.query.search ?? "").trim();
      const limitRaw = Number(req.query.limit ?? 100);
      if (!WINDOWS.includes(window as WindowKey)) return res.status(400).json({ error: "Invalid window" });
      if (!PUBLIC_SORTS.includes(sort)) return res.status(400).json({ error: "Invalid sort" });
      if (direction !== "asc" && direction !== "desc") return res.status(400).json({ error: "Invalid direction" });
      if (search.length > 120) return res.status(400).json({ error: "Search too long" });
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) return res.status(400).json({ error: "Invalid limit" });

      const { rows: allRows, asOfDate } = loadDemoRowsForWindow(window as WindowKey, "demo", sort, PASS_PLAYER_EVIDENCE, "latest");
      const genres = Array.from(new Set(allRows.flatMap(r => r.genre?.split(", ") ?? []))).sort();
      if (genre && !genres.includes(genre)) return res.status(400).json({ error: "Invalid genre" });

      const peaks = windowPeakByDemoId(window as WindowKey);
      const rows: PublicRow[] = allRows
        .filter(r => !["top", "new"].includes(sort) || !r.isArchived)
        .filter(r => (sort !== "top" && sort !== "new") || r.sourceRank != null)
        .filter(r => !genre || (r.genre ?? "").split(", ").includes(genre))
        .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.steamAppId === search)
        .map(r => ({ ...publicLeaderboardRow(r, peaks.get(r.id) ?? null), id: r.id, nameKey: r.name }));

      if (sort === "top" || sort === "new") {
        rows.sort((a, b) => (a.sourceRank ?? 0) - (b.sourceRank ?? 0) || a.nameKey.localeCompare(b.nameKey) || a.id - b.id);
      } else {
        rows.sort((a, b) => {
          const av = sortValue(sort, a);
          const bv = sortValue(sort, b);
          if (av == null && bv == null) return a.nameKey.localeCompare(b.nameKey) || a.id - b.id;
          if (av == null) return 1;
          if (bv == null) return -1;
          const comparison = typeof av === "string" ? av.localeCompare(String(bv)) : av - Number(bv);
          return (direction === "asc" ? comparison : -comparison) || a.nameKey.localeCompare(b.nameKey) || a.id - b.id;
        });
      }

      const demos = rows.slice(0, limitRaw).map((r, i) => {
        const { id: _id, nameKey: _nameKey, ...pub } = r;
        return { ...pub, rank: i + 1 };
      });
      res.set("Cache-Control", "no-store").json({
        scope: "steam-demos",
        window,
        sort,
        direction,
        genre: genre || null,
        genres,
        asOfDate,
        availableCount: rows.length,
        limit: limitRaw,
        count: demos.length,
        peakCcuNote: "Peak CCU is the max of our hourly samples inside the selected window (observed), not Steam's chart figure.",
        demos,
      });
    } catch {
      res.status(500).json({ error: "Demo leaderboard unavailable. Please retry." });
    }
  });

  app.get("/api/demos/public/titles/:appId", publicDemoLimiter, (req, res) => {
    try {
      const appId = String(req.params.appId);
      if (!/^[1-9]\d{0,9}$/.test(appId)) return res.status(404).json({ error: "Tracked demo not found" });
      const t = loadDemoCatalog("demo").find(x => x.steam_app_id === appId);
      if (!t) return res.status(404).json({ error: "Tracked demo not found. Friends Passes are excluded." });
      const range = String(req.query.days ?? "30") as DemoRange;
      if (!["7", "30", "90", "365", "all"].includes(range)) return res.status(400).json({ error: "Invalid history range" });

      const saber = t.is_saber_published === 1;
      const archived = t.is_active !== 1;
      const snapshot = archived ? archivedSnapshot(t) : null;
      const summary = loadDemoDetailSummary(t.steam_app_id);
      const latest: DemoDetail["latest"] = snapshot ?? (summary
        ? {
            downloads: summary.unitsMid,
            observedMinimum: summary.isObservedMinimum,
            reviews: summary.reviewCountTotal,
            positivePercent: summary.steamReviews?.positivePercent ?? null,
            ccu: summary.ccuCurrent,
            peak: summary.ccuAllTimePeak,
            ccuObservedAt: summary.ccuAsOf,
            ccuRecentPeak: summary.ccuRecentPeak,
            ccuRecentPeakSource: summary.ccuRecentPeakSource,
            ccuSteamRank: summary.ccuSteamRank,
            ccuRecentPeakAsOf: summary.ccuRecentPeakAsOf,
            actualsAsOf: summary.actualsAsOf,
            actualsStale: summary.actualsStale,
            actualsRefreshFailed: summary.actualsRefreshFailed,
          }
        : {
            downloads: null, observedMinimum: false, reviews: null, positivePercent: null,
            ccu: null, peak: null, ccuObservedAt: null, ccuRecentPeak: null,
            ccuRecentPeakSource: null, ccuSteamRank: null, ccuRecentPeakAsOf: null,
            actualsAsOf: null, actualsStale: false, actualsRefreshFailed: false,
          });

      const { start, end, firstHistoryDate, rows } = loadDemoHistory(rawSqlite, t, range);
      // Public history rows: DemoHistoryPoint minus nothing (its fields are
      // display provenance shown on the demo PDP), enumerated explicitly.
      const publicRows: DemoHistoryPoint[] = rows.map(r => ({
        date: r.date,
        dailyDownloads: r.dailyDownloads,
        netLifetimeChange: r.netLifetimeChange,
        reportedDownloadsToDate: r.reportedDownloadsToDate,
        dailyDownloadSource: r.dailyDownloadSource,
        dailyReportFetchedAt: r.dailyReportFetchedAt,
        cumulativeReportFetchedAt: r.cumulativeReportFetchedAt,
        reviewActivitySource: r.reviewActivitySource,
        lifetimeDownloads: r.lifetimeDownloads,
        downloadObservedAt: r.downloadObservedAt,
        reportEndDate: r.reportEndDate,
        downloadMethod: r.downloadMethod,
        multiplierId: r.multiplierId,
        reviewsAdded: r.reviewsAdded,
        positiveAdded: r.positiveAdded,
        negativeAdded: r.negativeAdded,
        reviewBucketObservedAt: r.reviewBucketObservedAt,
        totalReviews: r.totalReviews,
        positivePercent: r.positivePercent,
        reviewObservedAt: r.reviewObservedAt,
        reviewSource: r.reviewSource,
        ccuLatest: r.ccuLatest,
        ccuPeak: r.ccuPeak,
        ccuSamples: r.ccuSamples,
      }));

      let latestWindows: DemoDetail["latestWindows"];
      if (saber) {
        latestWindows = rawSqlite
          .prepare(`SELECT window,downloads,fetched_at AS asOf,source FROM demo_download_actuals
            WHERE steam_app_id=? AND source='steamworks_downloads_report'`)
          .all(t.steam_app_id) as DemoDetail["latestWindows"];
      } else {
        latestWindows = rawSqlite
          .prepare(`SELECT e.window,e.units_mid AS downloads,e.as_of_date AS asOf,e.multiplier_id AS source
            FROM demo_window_estimates_daily e WHERE demo_title_id=? AND method='review_delta_multiplier'
            AND e.as_of_date=(SELECT MAX(n.as_of_date) FROM demo_window_estimates_daily n
              WHERE n.demo_title_id=e.demo_title_id AND n.window=e.window AND n.method='review_delta_multiplier')`)
          .all(t.id) as DemoDetail["latestWindows"];
      }
      latestWindows = latestWindows.sort((a, b) => ["d7", "d30", "d90", "m12", "ltd"].indexOf(a.window) - ["d7", "d30", "d90", "m12", "ltd"].indexOf(b.window));

      const meta = rawSqlite
        .prepare(`SELECT first_seen_at,last_checked_at,deactivated_at FROM demo_titles WHERE id=?`)
        .get(t.id) as { first_seen_at: string | null; last_checked_at: string | null; deactivated_at: string | null };

      res.set("Cache-Control", "no-store").json({
        // Explicit public allowlist of DemoDetail: no historyCoverage jobs or
        // checks (pipeline internals), everything else matches the PDP.
        appId,
        name: t.name,
        isSaber: saber,
        archived,
        genre: t.genre,
        releaseDate: t.release_date,
        firstSeenAt: meta.first_seen_at,
        lastCheckedAt: meta.last_checked_at,
        deactivatedAt: meta.deactivated_at,
        snapshotAsOf: snapshot?.snapshotAsOf ?? null,
        multiplier: saber ? null : NON_SABER_DOWNLOAD_TRIAL,
        range,
        start,
        end,
        firstHistoryDate,
        latest,
        latestWindows,
        rows: publicRows,
        historyCoverage: {
          dailyReportDays: rows.filter(r => r.dailyDownloads != null && Number(r.dailyDownloads) > 0).length,
          cumulativeReportDays: rows.filter(r => r.reportedDownloadsToDate != null).length,
          recoveredReviewDays: rows.filter(r => r.dailyDownloads != null && r.dailyDownloadSource === "manual_calibration").length,
          histogramDays: rows.filter(r => r.reviewsAdded != null).length,
        },
      });
    } catch {
      res.status(500).json({ error: "Demo history unavailable. Please retry." });
    }
  });

  app.get("/api/demos/public/titles/:appId/media", publicDemoLimiter, (req, res) => {
    getDemoMedia(String(req.params.appId))
      .then(data => {
        res.set("Cache-Control", "no-store").json(data);
      })
      .catch(() => res.status(500).json({ error: "Demo media unavailable. Please retry." }));
  });
}
