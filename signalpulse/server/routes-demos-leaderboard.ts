/**
 * Steam Demos leaderboard API.
 *
 * Route: GET /api/demos/leaderboard
 * Query: window=d7|d30|d90|m12|ltd (default d7, matches the established
 *          console-leaderboard / hmap wishlist-leaderboard convention)
 *        sort=top|new|reviews|downloads|ccu|peak|release
 *        direction=asc|desc (metric/date sorts; default desc)
 *        genre=<exact broad Steam genre>
 *        limit=1..100 (default 50)
 *
 * Ranking:
 *   sort=downloads (default) -- units_mid desc, from
 *     demo_window_estimates_daily for the requested window. This is a
 *     PROVISIONAL estimate (method='review_delta_multiplier' for
 *     everything currently, pending Saber's own Steamworks ground truth)
 *     -- units_low/units_high are always returned alongside units_mid so
 *     the low-confidence range is never hidden behind a single number.
 *   sort=ccu -- latest sampled concurrent-player count, not a live feed.
 *   sort=top|new -- the latest successful verified source snapshot,
 *     preserving Steam's order independently of estimates or CCU.
 * Coverage includes per-feed attempts/success/error and candidate counts.
 *
 * Only demos with is_active=1 are ranked (deactivated demos have no live
 * CCU and typically frozen review history -- see signals/demos/runner.ts
 * deactivation handling). Deactivated Saber demos (Toxic Commando, The
 * Knightling, Bus Bound, Painkiller) are visible via
 * GET /api/demos/saber-archive instead, for historical reference.
 */

import type { Express } from "express";
import { rawSqlite } from "./storage";
import { WINDOWS, type WindowKey } from "./signals/demos/estimator";
import { DEMO_FEED_LIMIT } from "./signals/demos/feeds";

type DemoSort = "top" | "new" | "reviews" | "downloads" | "ccu" | "peak" | "release";

interface DemoLeaderboardRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
  releaseDate: string | null;
  isSaberPublished: boolean;
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
}

function loadLeaderboardRows(window: WindowKey, sort: DemoSort, direction: "asc" | "desc", genre: string, limit: number) {
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

  const demos = rawSqlite
    .prepare(`SELECT id, steam_app_id, name, genre, release_date, is_saber_published FROM demo_titles WHERE is_active = 1`)
    .all() as Array<{ id: number; steam_app_id: string; name: string; genre: string | null; release_date: string | null; is_saber_published: number }>;
  const sourceRanks = new Map((rawSqlite.prepare(
    "SELECT demo_title_id,source_rank FROM demo_discovery_ranks WHERE feed=?"
  ).all(sort) as Array<{ demo_title_id: number; source_rank: number }>)
    .map(row => [row.demo_title_id, row.source_rank]));

  let asOfDate: string | null = null;
  const rows: DemoLeaderboardRow[] = demos
    .filter(d => (sort !== "top" && sort !== "new") || sourceRanks.has(d.id))
    .filter(d => !genre || (d.genre ?? "").split(", ").includes(genre))
    .map((d) => {
    const est = estimateByDemoId.get(d.id);
    const snap = ccuCurrentByDemoId.get(d.id);
    if (est?.as_of_date && (!asOfDate || est.as_of_date > asOfDate)) asOfDate = est.as_of_date;
    return {
      id: d.id,
      steamAppId: d.steam_app_id,
      name: d.name,
      genre: d.genre,
      releaseDate: d.release_date,
      isSaberPublished: d.is_saber_published === 1,
      reviewCountTotal: est?.review_count_total ?? null,
      reviewDelta: est?.review_delta ?? null,
      unitsLow: est?.units_low ?? null,
      unitsMid: est?.units_mid ?? null,
      unitsHigh: est?.units_high ?? null,
      method: est?.method ?? null,
      ccuCurrent: snap?.ccu ?? null,
      ccuAllTimePeak: ccuPeakByDemoId.get(d.id) ?? null,
      ccuAsOf: snap?.captured_at ?? null,
      sourceRank: sourceRanks.get(d.id) ?? null,
    };
  });

  if (sort === "top" || sort === "new") {
    rows.sort((a, b) => a.sourceRank! - b.sourceRank!);
  } else {
    const value = (row: DemoLeaderboardRow): number | string | null => sort === "reviews" ? row.reviewCountTotal
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
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

      if (!WINDOWS.includes(window)) return res.status(400).json({ error: "invalid window" });
      if (!["top","new","reviews","downloads","ccu","peak","release"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      if (direction !== "asc" && direction !== "desc") return res.status(400).json({ error: "invalid direction" });

      const genres = Array.from(new Set((rawSqlite.prepare(
        "SELECT genre FROM demo_titles WHERE is_active=1 AND genre IS NOT NULL"
      ).all() as Array<{ genre: string }>).flatMap(row => row.genre.split(", ")))).sort();
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
        coverage: { candidateLimitPerFeed: DEMO_FEED_LIMIT, feeds },
        multiplier: { low: 30, mid: 65.5, high: 100, note: "Provisional -- single-anchor calibration, see estimator.ts" },
        count: rows.length,
        demos: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deactivated Saber demos (Toxic Commando, The Knightling, Bus Bound,
  // Painkiller) -- historical reference, not ranked on the live board.
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
