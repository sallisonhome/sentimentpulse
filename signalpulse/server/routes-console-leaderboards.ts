/**
 * Console leaderboards + PDP API routes.
 *
 * Endpoints:
 *   GET /api/console/leaderboards/:platform
 *     Query:
 *       window = d7|d30|d90|m12|ltd  (default d30)
 *       sort   = revenue|units|ratings|score   (default revenue)
 *       dir    = asc|desc   (default desc)
 *
 *     Returns top-100 titles for that platform for the requested window.
 *
 *     Ranking columns:
 *       revenue  = units_mid * msrp_usd_cents / 100 (window-scoped)
 *       units    = window_estimates_daily.units_mid
 *       ratings  = store_rating_signal_daily.rating_count (latest LTD snapshot)
 *       score    = store_rating_signal_daily.avg_rating   (latest LTD snapshot)
 *
 *     Ratings and score feed the estimator; they are also user-selectable
 *     sort keys. Titles with a NULL sort value sink to the bottom rather
 *     than being excluded, so the client still gets a full 100 rows even
 *     before the estimator has populated every window. rating_count is a
 *     stable-sort tie-breaker for every sort mode.
 *
 *     Only rows with business_model = 'paid' AND sku_role = 'base' are returned.
 *
 *   GET /api/console/titles/:titleId
 *     Returns PDP header data: title metadata, current LTD snapshot per platform,
 *     IGDB enrichment (cover, screenshots, genres, developers), platform SKUs.
 *
 *   GET /api/console/titles/:titleId/timeseries
 *     Query: platform=steam|xbox|ps5   (required)
 *            from=YYYY-MM-DD           (optional, default 90d ago)
 *            to=YYYY-MM-DD             (optional, default today)
 *            metric=rating_count|avg_rating|owners_mid  (default rating_count)
 *     Returns array of { date, value } points from store_rating_signal_daily
 *     joined with window_estimates_daily.
 *
 *   POST /api/console/igdb/refresh/:titleId
 *     Admin-only re-cache of IGDB metadata for one title.
 */

import type { Express } from "express";
import { rawSqlite } from "./storage";
import { refreshIgdbForTitle } from "./signals/console/igdb";

type Platform = "steam" | "xbox" | "ps5";
const PLATFORMS: Platform[] = ["steam", "xbox", "ps5"];

function parseDate(v: string | undefined, fallback: string): string {
  if (!v) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  return v;
}

function todayIsoDate(): string { return new Date().toISOString().slice(0, 10); }
function daysAgo(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function registerConsoleLeaderboardRoutes(app: Express) {

  // ─── Leaderboard list ─────────────────────────────────────────────────────
  app.get("/api/console/leaderboards/:platform", (req, res) => {
    try {
      const platform = req.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
      const window = (req.query.window as string) || "d30";
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });

      // Sort mode + direction. Whitelist rather than string-interpolate to keep
      // the query prepareable and to prevent injection through the query string.
      const sort = ((req.query.sort as string) || "revenue").toLowerCase();
      if (!["revenue","units","ratings","score"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      const dir = ((req.query.dir as string) || "desc").toLowerCase();
      if (!["asc","desc"].includes(dir)) return res.status(400).json({ error: "invalid dir" });

      // sortExpr maps each sort key to the column expression. revenue is
      // units × msrp/100 (dollars), so a title with unknown msrp (NULL) sinks.
      const SORT_EXPR: Record<string, string> = {
        revenue: "(w.units_mid * psm.msrp_usd_cents / 100.0)",
        units:   "w.units_mid",
        ratings: "srs.rating_count",
        score:   "srs.avg_rating",
      };
      const sortExpr = SORT_EXPR[sort];
      const dirSql = dir === "asc" ? "ASC" : "DESC";

      // Grab latest daily rating snapshot per (title, platform). Only paid business_model.
      const rows = rawSqlite.prepare(`
        WITH latest_rating AS (
          SELECT title_id, platform, MAX(capture_date) AS max_date
            FROM store_rating_signal_daily
           WHERE platform = ?
           GROUP BY title_id, platform
        )
        SELECT
          psm.title_id                              AS titleId,
          psm.external_sku                          AS externalSku,
          psm.msrp_usd_cents                        AS msrpUsdCents,
          psm.business_model                        AS businessModel,
          igdb.name                                 AS name,
          igdb.cover_url                            AS coverUrl,
          igdb.release_date                         AS releaseDate,
          srs.rating_count                          AS ratingCount,
          srs.avg_rating                            AS avgRating,
          srs.capture_date                          AS ratingCapturedAt,
          w.owners_mid                              AS ownersMid,
          w.units_mid                               AS unitsMid,
          -- Estimated in-window revenue in USD dollars = units × MSRP.
          -- No discount factor applied yet; treat as an MSRP-anchored ceiling.
          (w.units_mid * psm.msrp_usd_cents / 100.0) AS revenueMidUsd,
          w.gated_reason                            AS gatedReason
        FROM platform_sku_map psm
        LEFT JOIN latest_rating lr
               ON lr.title_id = psm.title_id AND lr.platform = psm.platform
        LEFT JOIN store_rating_signal_daily srs
               ON srs.title_id = psm.title_id
              AND srs.platform = psm.platform
              AND srs.capture_date = lr.max_date
        LEFT JOIN console_title_igdb igdb
               ON igdb.title_id = psm.title_id
        LEFT JOIN window_estimates_daily w
               ON w.title_id = psm.title_id
              AND w.platform = psm.platform
              AND w.window = ?
              AND w.as_of_date = (SELECT MAX(as_of_date) FROM window_estimates_daily
                                    WHERE title_id = psm.title_id AND platform = psm.platform AND window = ?)
       WHERE psm.platform = ?
         AND psm.business_model = 'paid'
         AND psm.sku_role = 'base'
       -- Default sort is estimated revenue for the selected window. User can
       -- switch to units, ratings, or score via ?sort=. NULL sort values sink
       -- so the client still gets a full 100 rows even before the estimator
       -- has populated every window. rating_count is a stable-sort tie-breaker.
       ORDER BY (${sortExpr} IS NULL) ASC,
                ${sortExpr} ${dirSql},
                COALESCE(srs.rating_count, 0) DESC
       LIMIT 100
      `).all(platform, window, window, platform) as Array<Record<string, any>>;

      res.json({ platform, window, sort, dir, count: rows.length, titles: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PDP header ────────────────────────────────────────────────────────────
  app.get("/api/console/titles/:titleId", (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });

      const skus = rawSqlite.prepare(`
        SELECT platform, external_sku AS externalSku, concept_id AS conceptId, sku_role AS skuRole,
               business_model AS businessModel, msrp_usd_cents AS msrpUsdCents, refreshed_at AS refreshedAt
          FROM platform_sku_map WHERE title_id = ? ORDER BY platform
      `).all(titleId) as Array<Record<string, any>>;

      if (skus.length === 0) return res.status(404).json({ error: "title not found" });

      const igdb = rawSqlite.prepare(`
        SELECT igdb_id AS igdbId, slug, name, summary, release_date AS releaseDate,
               cover_url AS coverUrl, artwork_url AS artworkUrl,
               screenshots_json AS screenshotsJson, genres_json AS genresJson,
               themes_json AS themesJson, platforms_json AS platformsJson,
               developers_json AS developersJson, publishers_json AS publishersJson,
               rating, rating_count AS ratingCount, refreshed_at AS refreshedAt
          FROM console_title_igdb WHERE title_id = ?
      `).get(titleId) as Record<string, any> | undefined;

      // Current LTD-ish rating snapshot per platform (most recent capture)
      const latestPerPlatform = rawSqlite.prepare(`
        SELECT srs.platform, srs.capture_date AS captureDate, srs.rating_count AS ratingCount,
               srs.avg_rating AS avgRating, srs.window_label AS windowLabel
          FROM store_rating_signal_daily srs
          JOIN (SELECT platform, MAX(capture_date) AS md
                  FROM store_rating_signal_daily WHERE title_id = ?
                 GROUP BY platform) x
            ON x.platform = srs.platform AND x.md = srs.capture_date
         WHERE srs.title_id = ?
      `).all(titleId, titleId) as Array<Record<string, any>>;

      // Parse JSON columns
      const parsedIgdb = igdb ? {
        ...igdb,
        screenshots: igdb.screenshotsJson ? JSON.parse(igdb.screenshotsJson) : [],
        genres: igdb.genresJson ? JSON.parse(igdb.genresJson) : [],
        themes: igdb.themesJson ? JSON.parse(igdb.themesJson) : [],
        platforms: igdb.platformsJson ? JSON.parse(igdb.platformsJson) : [],
        developers: igdb.developersJson ? JSON.parse(igdb.developersJson) : [],
        publishers: igdb.publishersJson ? JSON.parse(igdb.publishersJson) : [],
      } : null;

      res.json({ titleId, skus, igdb: parsedIgdb, latestPerPlatform });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Timeseries for date-range picker ──────────────────────────────────────
  app.get("/api/console/titles/:titleId/timeseries", (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });
      const platform = req.query.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "platform required" });
      const metric = (req.query.metric as string) || "rating_count";
      if (!["rating_count", "avg_rating", "owners_mid"].includes(metric)) return res.status(400).json({ error: "invalid metric" });
      const to = parseDate(req.query.to as string | undefined, todayIsoDate());
      const from = parseDate(req.query.from as string | undefined, daysAgo(90));

      let points: Array<{ date: string; value: number | null }> = [];
      if (metric === "owners_mid") {
        const window = (req.query.window as string) || "d30";
        points = rawSqlite.prepare(`
          SELECT as_of_date AS date, owners_mid AS value
            FROM window_estimates_daily
           WHERE title_id = ? AND platform = ? AND window = ?
             AND as_of_date >= ? AND as_of_date <= ?
           ORDER BY as_of_date
        `).all(titleId, platform, window, from, to) as Array<{ date: string; value: number | null }>;
      } else {
        const col = metric === "avg_rating" ? "avg_rating" : "rating_count";
        points = rawSqlite.prepare(`
          SELECT capture_date AS date, ${col} AS value
            FROM store_rating_signal_daily
           WHERE title_id = ? AND platform = ?
             AND capture_date >= ? AND capture_date <= ?
           ORDER BY capture_date
        `).all(titleId, platform, from, to) as Array<{ date: string; value: number | null }>;
      }

      res.json({ titleId, platform, metric, from, to, points });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── IGDB manual refresh (admin) ───────────────────────────────────────────
  app.post("/api/console/igdb/refresh/:titleId", async (req, res) => {
    try {
      const titleId = parseInt(req.params.titleId, 10);
      if (!Number.isFinite(titleId)) return res.status(400).json({ error: "invalid titleId" });
      const name = (req.body?.name as string) || undefined;
      if (!name) return res.status(400).json({ error: "name required" });
      const result = await refreshIgdbForTitle(titleId, name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
