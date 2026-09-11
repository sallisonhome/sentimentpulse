/**
 * Console leaderboards + PDP API routes.
 *
 * Endpoints:
 *   GET /api/console/leaderboards/:platform
 *     Query:
 *       window = d7|d30|d90|m12|ltd  (default d30)
 *       sort   = revenue|units|ratings|score|asp   (default revenue)
 *       dir    = asc|desc   (default desc)
 *
 *     Returns top-100 titles for that platform for the requested window.
 *
 *     Ranking columns:
 *       revenue  = units_mid * asp_usd_cents / 100 (window-scoped, ASP-adjusted)
 *       units    = window_estimates_daily.units_mid
 *       ratings  = store_rating_signal_daily.rating_count (latest LTD snapshot)
 *       score    = store_rating_signal_daily.avg_rating   (latest LTD snapshot)
 *
 *     ASP factors (fraction of MSRP realized per platform, applied to revenue only):
 *       steam 0.66  (heavy discounting + regional pricing)
 *       ps5   0.80  (year-round PSN Store discounts + PS+ Extra bundling)
 *       xbox  0.80  (Microsoft Store discounts + Game Pass rev share)
 *     Configurable via app_settings keys asp_factor_steam / asp_factor_ps5 /
 *       asp_factor_xbox; defaults live in ASP_FACTOR_DEFAULTS below.
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

// Platform ASP factors used to translate MSRP into an Average Selling Price
// estimate. Applied at read time so an operator can retune without a re-run
// of the estimator. Kept out of window_estimates_daily on purpose: units are
// the modelled quantity; ASP is a downstream pricing overlay.
const ASP_FACTOR_DEFAULTS: Record<Platform, number> = {
  steam: 0.66,
  ps5:   0.80,
  xbox:  0.80,
};

function aspFactorFor(platform: Platform): number {
  // app_settings override lets us retune from the Settings UI without a deploy.
  try {
    const r = rawSqlite
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(`asp_factor_${platform}`) as { value: string } | undefined;
    if (r && r.value != null) {
      const v = parseFloat(r.value);
      if (Number.isFinite(v) && v > 0 && v <= 1) return v;
    }
  } catch { /* app_settings may not exist in an odd sandbox */ }
  return ASP_FACTOR_DEFAULTS[platform];
}

export function registerConsoleLeaderboardRoutes(app: Express) {

  // ─── Leaderboard list ─────────────────────────────────────────────────────
  app.get("/api/console/leaderboards/:platform", (req, res) => {
    try {
      const platform = req.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
      // Default is the 7d window so fresh weekly hits (launches like
      // Halloween: The Game and How to Fish) surface first. Because the
      // estimator sometimes doesn't have 7d numbers yet for very recent
      // launches, the SQL below cascades w.units_mid through d7→d30→d90→ltd
      // per-row so revenue/units always fills top-100 even when a specific
      // window is thin. The `windowUsed` column on each row tells the client
      // which underlying window produced the number.
      const window = (req.query.window as string) || "d7";
      if (!["d7","d30","d90","m12","ltd"].includes(window)) return res.status(400).json({ error: "invalid window" });

      // Sort mode + direction. Whitelist rather than string-interpolate to keep
      // the query prepareable and to prevent injection through the query string.
      const sort = ((req.query.sort as string) || "revenue").toLowerCase();
      if (!["revenue","units","ratings","score","asp"].includes(sort)) return res.status(400).json({ error: "invalid sort" });
      const dir = ((req.query.dir as string) || "desc").toLowerCase();
      if (!["asc","desc"].includes(dir)) return res.status(400).json({ error: "invalid dir" });

      const aspFactor = aspFactorFor(platform);

      // sortExpr maps each sort key to the column expression. revenue is
      // units × asp/100 (dollars), where asp = msrp × platform ASP factor,
      // so a title with unknown msrp (NULL) sinks. The ASP factor is a
      // constant per request — sqlite treats it as a bound parameter below.
      //
      // Sort expressions reference the CASCADED window value (built below as
      // cascadeUnits) rather than a single window's row, so a title with only
      // 30d data still sorts sensibly against titles that have real 7d data.
      const sortExprFor = (cascadeUnitsSql: string): Record<string, string> => ({
        revenue: `(${cascadeUnitsSql} * psm.msrp_usd_cents * ? / 100.0)`,
        units:   cascadeUnitsSql,
        ratings: "srs.rating_count",
        score:   "srs.avg_rating",
        // ASP sort ranks by MSRP directly since ASP = MSRP × platform factor is
        // a fixed monotonic multiplier per platform. Cheaper avoids two more binds.
        asp:     "psm.msrp_usd_cents",
      });
      const dirSql = dir === "asc" ? "ASC" : "DESC";

      // Row-level window cascade. Business rule:
      //   Bias toward the requested window (default 7d), but if that window has
      //   no estimate yet for a given (title, platform), fall back to the next
      //   wider window so the row still ranks. Order: d7 → d30 → d90 → m12 → ltd.
      //   Never widen NARROWER (e.g. d30 request doesn't fall to d7): that would
      //   break the semantics of a user asking specifically for the 30d view.
      const CASCADE_BY_WINDOW: Record<string, string[]> = {
        d7:  ["d7", "d30", "d90", "m12", "ltd"],
        d30: ["d30", "d90", "m12", "ltd"],
        d90: ["d90", "m12", "ltd"],
        m12: ["m12", "ltd"],
        ltd: ["ltd"],
      };
      const cascade = CASCADE_BY_WINDOW[window];

      // "Recent hot" = the title released in the last 30 days AND has any 7d
      // estimate at all. Surfaces launches like Halloween: The Game (2026-09-08)
      // and How to Fish (2026-08-20) with a badge so the operator can see the
      // 7d chart is being driven by new releases rather than tenured titles.
      const recentHotThresholdIso = daysAgo(30);

      // Build the LEFT JOIN chain for the cascade. Each level pulls its own
      // latest as_of_date so a stale d7 row from last week doesn't win over a
      // fresh d30 row from today. Window strings are HARDCODED from the whitelist
      // above (never user input) so it's safe to interpolate directly.
      const cascadeJoins = cascade.map((w, i) => `
        LEFT JOIN window_estimates_daily w${i}
               ON w${i}.title_id = psm.title_id
              AND w${i}.platform = psm.platform
              AND w${i}.window = '${w}'
              AND w${i}.as_of_date = (SELECT MAX(as_of_date) FROM window_estimates_daily
                                        WHERE title_id = psm.title_id AND platform = psm.platform AND window = '${w}')
      `).join("\n");

      // COALESCE picks the first non-null level in cascade order. The parallel
      // CASE expression records which window actually produced the value so the
      // client can badge "est. via 30d" when 7d was empty.
      const cascadeUnits = "COALESCE(" + cascade.map((_, i) => `w${i}.units_mid`).join(", ") + ")";
      const sortExpr = sortExprFor(cascadeUnits)[sort];
      // Bind the ASP factor twice for revenue sort (once in ORDER BY IS NULL,
      // once in ORDER BY sortExpr) so the constant lands in both slots.
      const sortBinds = sort === "revenue" ? [aspFactor, aspFactor] : [];
      const cascadeOwners = "COALESCE(" + cascade.map((_, i) => `w${i}.owners_mid`).join(", ") + ")";
      const cascadeGated = "COALESCE(" + cascade.map((_, i) => `w${i}.gated_reason`).join(", ") + ")";
      const cascadeWindowUsed = "CASE " + cascade.map((w, i) => `WHEN w${i}.units_mid IS NOT NULL THEN '${w}'`).join(" ") + " ELSE NULL END";
      // Method tag of the winning cascade level. The estimator writes
      // 'backfill-bootstrap' / 'backfill-steam-pace' / 'backfill-peer-ratio'
      // when a backfill source produced the value, otherwise it's the
      // multiplier's own method (e.g. 'v0-defaults'). Exposed so the UI can
      // badge rows that are running on inference vs. native/forward-delta.
      const cascadeMethod = "CASE " + cascade.map((_, i) => `WHEN w${i}.units_mid IS NOT NULL THEN w${i}.method`).join(" ") + " ELSE NULL END";

      // Recent-hot needs the STRICT 7d estimate, which is w0 only when the
      // requested window is d7. For wider requests we do a small correlated
      // EXISTS to check 7d explicitly.
      const recentHot7dTest = window === "d7"
        ? "w0.units_mid IS NOT NULL"
        : "EXISTS (SELECT 1 FROM window_estimates_daily w7d WHERE w7d.title_id = psm.title_id AND w7d.platform = psm.platform AND w7d.window = 'd7' AND w7d.units_mid IS NOT NULL)";

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
          -- Name / cover selection:
          --   Prefer IGDB's canonical name/cover when the match looks trustworthy.
          --   When match_confidence='low' (release-date sanity check flagged a
          --   mismatch during IGDB refresh) OR IGDB has no data yet, fall back
          --   to the storefront's name / header art. Those are preserved on
          --   console_title_igdb (store_name / store_header_image_url) by
          --   bootstrapConsoleTitleNames() and are never overwritten by the
          --   IGDB refresh path. This fixes cases like Steam appid 3219630
          --   ("Halloween: The Game") whose IGDB search happened to match
          --   "Solitaire Game Halloween 2".
          CASE
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_name, ''), NULLIF(igdb.name, ''))
            ELSE COALESCE(NULLIF(igdb.name, ''), NULLIF(igdb.store_name, ''))
          END                                       AS name,
          CASE
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(NULLIF(igdb.store_header_image_url, ''), NULLIF(igdb.cover_url, ''))
            ELSE COALESCE(NULLIF(igdb.cover_url, ''), NULLIF(igdb.store_header_image_url, ''))
          END                                       AS coverUrl,
          -- Effective release date the isRecentHot flag and client badge read.
          -- When match_confidence='low' we know IGDB matched a different game
          -- (e.g. Solitaire Game Halloween 2 in place of Halloween: The Game),
          -- so its release_date is not trustworthy either — prefer the store's
          -- own date in that case. Otherwise prefer IGDB and fall back to the
          -- store's date only when IGDB is missing.
          CASE
            WHEN igdb.match_confidence = 'low'
              THEN COALESCE(igdb.store_release_date, igdb.release_date)
            ELSE COALESCE(igdb.release_date, igdb.store_release_date)
          END                                       AS releaseDate,
          -- nameSource lets the client badge each row.
          CASE
            WHEN igdb.match_confidence = 'low' THEN 'store'
            WHEN igdb.name IS NOT NULL AND igdb.name != '' THEN 'igdb'
            ELSE 'store'
          END                                       AS nameSource,
          igdb.match_confidence                     AS matchConfidence,
          srs.rating_count                          AS ratingCount,
          srs.avg_rating                            AS avgRating,
          -- Steam's native semantics are 'percent of ratings that are positive'
          -- (thumbs-up recommendations), NOT a 5-star mean. The collector rescales
          -- it to 0-5 as (up/total)*5 for cross-platform sortability, but that
          -- reads misleadingly on the UI: 70% recommended (which Steam labels
          -- 'Mixed') shows as 3.5/5, close to 'Positive' on a console-eye scale.
          --
          -- Expose the native percent alongside the 0-5 value and let the client
          -- render '87% · Very Positive' for Steam rows and keep '4.3' on PS5/Xbox.
          -- For non-Steam platforms these fields are null.
          --
          -- Percent is the exact inversion of the collector: avg_rating * 20.
          -- Label follows Steam's own bucket thresholds:
          --   >=95: Overwhelmingly Positive
          --   80-94: Very Positive
          --   70-79: Mostly Positive
          --   40-69: Mixed
          --   20-39: Mostly Negative
          --   0-19:  Overwhelmingly Negative
          CASE WHEN psm.platform = 'steam' AND srs.avg_rating IS NOT NULL
               THEN CAST(ROUND(srs.avg_rating * 20) AS INTEGER)
               ELSE NULL END                        AS avgRatingPercent,
          CASE WHEN psm.platform = 'steam' AND srs.avg_rating IS NOT NULL
               THEN CASE
                 WHEN srs.avg_rating * 20 >= 95 THEN 'Overwhelmingly Positive'
                 WHEN srs.avg_rating * 20 >= 80 THEN 'Very Positive'
                 WHEN srs.avg_rating * 20 >= 70 THEN 'Mostly Positive'
                 WHEN srs.avg_rating * 20 >= 40 THEN 'Mixed'
                 WHEN srs.avg_rating * 20 >= 20 THEN 'Mostly Negative'
                 ELSE 'Overwhelmingly Negative'
               END
               ELSE NULL END                        AS avgRatingLabel,
          srs.capture_date                          AS ratingCapturedAt,
          ${cascadeOwners}                          AS ownersMid,
          ${cascadeUnits}                           AS unitsMid,
          ${cascadeWindowUsed}                      AS windowUsed,
          ${cascadeMethod}                          AS estimateMethod,
          -- ASP (Average Selling Price) in USD cents = MSRP × platform ASP factor.
          -- Kept as an integer-cents value so the client formats it the same as MSRP.
          CAST(psm.msrp_usd_cents * ? AS INTEGER)   AS aspUsdCents,
          -- Estimated in-window revenue in USD dollars = cascaded units × ASP.
          -- ASP applies platform-specific realization (steam ~66%, consoles ~80%).
          (${cascadeUnits} * psm.msrp_usd_cents * ? / 100.0) AS revenueMidUsd,
          ${cascadeGated}                           AS gatedReason,
          -- Recent-hot flag = released in the last 30d AND has a real 7d estimate.
          -- Same confidence-aware date resolution as the releaseDate column: when
          -- IGDB matched the wrong game we prefer the store's own date, since
          -- IGDB's release_date would otherwise refer to a completely different
          -- game and hide a brand-new launch from the Recent hot badge.
          CASE WHEN (
                 CASE WHEN igdb.match_confidence = 'low'
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) IS NOT NULL
                AND (
                 CASE WHEN igdb.match_confidence = 'low'
                   THEN COALESCE(igdb.store_release_date, igdb.release_date)
                   ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                 END
               ) >= ?
                AND ${recentHot7dTest}
               THEN 1 ELSE 0 END                    AS isRecentHot
        FROM platform_sku_map psm
        LEFT JOIN latest_rating lr
               ON lr.title_id = psm.title_id AND lr.platform = psm.platform
        LEFT JOIN store_rating_signal_daily srs
               ON srs.title_id = psm.title_id
              AND srs.platform = psm.platform
              AND srs.capture_date = lr.max_date
        LEFT JOIN console_title_igdb igdb
               ON igdb.title_id = psm.title_id
        ${cascadeJoins}
       WHERE psm.platform = ?
         AND psm.business_model = 'paid'
         AND psm.sku_role = 'base'
       -- NULL sort values sink so the client still gets a full 100 rows even
       -- before the estimator has populated every window. rating_count is a
       -- stable-sort tie-breaker for every sort mode.
       -- Recent-hot titles get a small tie-breaker bump so a Sep-8 launch
       -- with the same revenue as a tenured title still lands above it in
       -- the 7d view.
       ORDER BY (${sortExpr} IS NULL) ASC,
                ${sortExpr} ${dirSql},
                (CASE WHEN (
                   CASE WHEN igdb.match_confidence = 'low'
                     THEN COALESCE(igdb.store_release_date, igdb.release_date)
                     ELSE COALESCE(igdb.release_date, igdb.store_release_date)
                   END
                 ) >= ? THEN 1 ELSE 0 END) DESC,
                COALESCE(srs.rating_count, 0) DESC
       LIMIT 100
      `).all(
        platform,               // 1: latest_rating CTE WHERE platform = ?
        aspFactor,              // 2: SELECT aspUsdCents CAST(msrp * ? AS INTEGER)
        aspFactor,              // 3: SELECT revenueMidUsd = units * msrp * ? / 100
        recentHotThresholdIso,  // 4: isRecentHot release_date >= ?
        platform,               // 5: outer WHERE psm.platform = ?
        ...sortBinds,           // 6,7: ORDER BY sortExpr contains one ? per use (twice when sort=revenue)
        recentHotThresholdIso,  // last: ORDER BY recent-hot tie-breaker release_date >= ?
      ) as Array<Record<string, any>>;

      res.json({ platform, window, sort, dir, aspFactor, cascade, count: rows.length, titles: rows });
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
