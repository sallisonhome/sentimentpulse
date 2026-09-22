/**
 * Steam Demos leaderboard API.
 *
 * Route: GET /api/demos/leaderboard
 * Query: window=d7|d30|d90|m12|ltd (default d7, matches the established
 *          console-leaderboard / hmap wishlist-leaderboard convention)
 *        sort=downloads|ccu (default downloads)
 *        limit=1..100 (default 50 -- "top 50" per project scope; the
 *          underlying demo_titles universe currently holds ~55 rows:
 *          ~49 from the Steam Demos hub's top-50 "New & Trending" tab +
 *          Saber's own roster, several of which are deactivated and
 *          therefore excluded below)
 *
 * Ranking:
 *   sort=downloads (default) -- units_mid desc, from
 *     demo_window_estimates_daily for the requested window. This is a
 *     PROVISIONAL estimate (method='review_delta_multiplier' for
 *     everything currently, pending Saber's own Steamworks ground truth)
 *     -- units_low/units_high are always returned alongside units_mid so
 *     the low-confidence range is never hidden behind a single number.
 *   sort=ccu -- live/latest current-player-count desc, matching SteamDB's
 *     "Most played game demos" chart (steamdb.info/charts/?category=10)
 *     Current column. all_time_peak_ccu is also always returned.
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

interface DemoLeaderboardRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
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
}

function loadLeaderboardRows(window: WindowKey, sort: "downloads" | "ccu", limit: number): { rows: DemoLeaderboardRow[]; asOfDate: string | null } {
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
    .prepare(`SELECT id, steam_app_id, name, genre, is_saber_published FROM demo_titles WHERE is_active = 1`)
    .all() as Array<{ id: number; steam_app_id: string; name: string; genre: string | null; is_saber_published: number }>;

  let asOfDate: string | null = null;
  const rows: DemoLeaderboardRow[] = demos.map((d) => {
    const est = estimateByDemoId.get(d.id);
    const snap = ccuCurrentByDemoId.get(d.id);
    if (est?.as_of_date && (!asOfDate || est.as_of_date > asOfDate)) asOfDate = est.as_of_date;
    return {
      id: d.id,
      steamAppId: d.steam_app_id,
      name: d.name,
      genre: d.genre,
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
    };
  });

  if (sort === "ccu") {
    rows.sort((a, b) => (b.ccuCurrent ?? -1) - (a.ccuCurrent ?? -1));
  } else {
    rows.sort((a, b) => (b.unitsMid ?? -1) - (a.unitsMid ?? -1));
  }

  return { rows: rows.slice(0, limit), asOfDate };
}

export function registerDemosLeaderboardRoutes(app: Express) {
  app.get("/api/demos/leaderboard", (req, res) => {
    try {
      const window = ((req.query.window as string) || "d7") as WindowKey;
      const sort = ((req.query.sort as string) || "downloads").toLowerCase();
      const limitRaw = parseInt((req.query.limit as string) || "50", 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

      if (!WINDOWS.includes(window)) return res.status(400).json({ error: "invalid window" });
      if (sort !== "downloads" && sort !== "ccu") return res.status(400).json({ error: "invalid sort" });

      const { rows, asOfDate } = loadLeaderboardRows(window, sort, limit);
      res.json({
        window,
        sort,
        asOfDate,
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
