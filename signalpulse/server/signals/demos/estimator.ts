/**
 * Steam Demos leaderboard — estimated-downloads estimator.
 *
 * Method: review_delta_multiplier. Sums the review count *added* within a
 * window (from steam_review_history, which already stores per-bucket
 * DELTAS — confirmed by reading signals/console/steam.ts's
 * fetchSteamRatingSignal, which sums bucket values into totalUp/totalDown
 * as a running cumulative total, i.e. each bucket is a period delta, not
 * a running total itself), then multiplies by a download-per-review ratio.
 *
 * ── Multiplier: PROVISIONAL / LOW CONFIDENCE ──────────────────────────
 * Anchored on exactly ONE verified data point this project has to date:
 * Clive Barker's Hellraiser: Revival demo (appid 5184670) —
 * 100,000 downloads (user-supplied, unverifiable via any Steam API) vs
 * 1,527 all-language reviews (steam store page, confirmed against
 * appreviews?language=all) => ~65.5x.
 *
 * This ratio is NOT assumed to generalize. Research this session (see
 * PR #109 history) found a Reddit anecdote citing a ~5,000x ratio for a
 * different demo, and an unresolved contradiction on a second demo
 * (Iron Nest: Heavy Turret Simulator) where the store-page review count
 * matched the ENGLISH-ONLY histogram total rather than the all-language
 * total for reasons that were never confirmed. Given that spread, this
 * estimator reports a low/mid/high RANGE (not a single number) per
 * PRINCIPLES: "prefer a transparent range over no estimate, never a
 * precise-looking guess." mid = the single verified anchor; low/high
 * bound a wide envelope around it until more Saber-side Steamworks
 * ground truth (units_actual, once that pull is built) can calibrate
 * per-genre or per-launch-type multipliers.
 *
 * Once Saber's own Steamworks Sales & Activations pull is wired up for
 * Hellraiser/Docked, THOSE demos should get method='steamworks_actual'
 * rows instead of this multiplier — this module intentionally never
 * overwrites a steamworks_actual row (see upsert below).
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";

export type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";

export const WINDOW_DAYS: Record<WindowKey, number | null> = {
  d7: 7,
  d30: 30,
  d90: 90,
  m12: 365,
  ltd: null, // null = no lower bound, full lifetime
};

export const WINDOWS: WindowKey[] = ["d7", "d30", "d90", "m12", "ltd"];

// downloads-per-review multiplier. See module doc comment for provenance.
export const DOWNLOAD_MULTIPLIER = { low: 30, mid: 65.5, high: 100 } as const;

interface DemoTitleForEstimate {
  id: number;
  steam_app_id: string;
  first_seen_at: string;
}

function loadEstimableDemos(): DemoTitleForEstimate[] {
  return rawSqlite
    .prepare(`SELECT id, steam_app_id, first_seen_at FROM demo_titles WHERE is_active = 1 OR deactivated_at IS NOT NULL`)
    .all() as DemoTitleForEstimate[];
}

/**
 * Sums recommendations_up+down within [windowStartUnix, now]. Avoids
 * double-counting between the day-grain "recent" buckets (last ~30 days)
 * and the coarser week/month "rollups" buckets, which both cover the
 * lifetime of the demo but at different, overlapping grains: rollup
 * buckets are only counted for the period BEFORE day-grain coverage
 * begins (bucket_start < minDayBucketStart).
 */
function sumReviewDelta(appId: string, windowStartUnix: number | null): number {
  const minDayRow = rawSqlite
    .prepare(`SELECT MIN(bucket_start) as m FROM steam_review_history WHERE app_id = ? AND bucket_granularity = 'day'`)
    .get(appId) as { m: number | null };
  const minDayBucketStart = minDayRow?.m ?? null;

  const daySumRow = rawSqlite
    .prepare(
      `SELECT COALESCE(SUM(recommendations_up + recommendations_down), 0) as s
       FROM steam_review_history
       WHERE app_id = ? AND bucket_granularity = 'day'
         AND (? IS NULL OR bucket_start >= ?)`
    )
    .get(appId, windowStartUnix, windowStartUnix) as { s: number };

  const rollupSumRow = rawSqlite
    .prepare(
      `SELECT COALESCE(SUM(recommendations_up + recommendations_down), 0) as s
       FROM steam_review_history
       WHERE app_id = ? AND bucket_granularity IN ('week','month')
         AND (? IS NULL OR bucket_start < ?)
         AND (? IS NULL OR bucket_start >= ?)`
    )
    .get(appId, minDayBucketStart, minDayBucketStart, windowStartUnix, windowStartUnix) as { s: number };

  return (daySumRow?.s ?? 0) + (rollupSumRow?.s ?? 0);
}

const upsertEstimateStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_window_estimates_daily
     (demo_title_id, window, as_of_date, review_count_total, review_delta,
      units_low, units_mid, units_high, multiplier_id, method, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(demo_title_id, window, as_of_date) DO UPDATE SET
     review_count_total = excluded.review_count_total,
     review_delta = excluded.review_delta,
     units_low = excluded.units_low,
     units_mid = excluded.units_mid,
     units_high = excluded.units_high,
     multiplier_id = excluded.multiplier_id,
     method = excluded.method
   -- Never clobber a steamworks_actual row with a multiplier estimate.
   WHERE demo_window_estimates_daily.method != 'steamworks_actual'`
);

export interface DemoEstimateRunResult {
  demosProcessed: number;
  rowsWritten: number;
}

/**
 * Computes and stores review_delta_multiplier estimates for every
 * window, for every demo that has at least some review history. Safe to
 * re-run any time (idempotent per demo_title_id+window+as_of_date; see
 * unique index). Call daily from a scheduled job.
 */
export function computeDemoWindowEstimates(asOfDate = new Date().toISOString().slice(0, 10)): DemoEstimateRunResult {
  const demos = loadEstimableDemos();
  const nowUnix = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  let rowsWritten = 0;

  for (const demo of demos) {
    // review_count_total: full lifetime, regardless of window.
    const reviewCountTotal = sumReviewDelta(demo.steam_app_id, null);
    if (reviewCountTotal === 0) continue; // no data yet — nothing to estimate

    for (const windowKey of WINDOWS) {
      const days = WINDOW_DAYS[windowKey];
      const windowStartUnix = days === null ? null : nowUnix - days * 86400;
      const reviewDelta = sumReviewDelta(demo.steam_app_id, windowStartUnix);

      const unitsLow = Math.round(reviewDelta * DOWNLOAD_MULTIPLIER.low);
      const unitsMid = Math.round(reviewDelta * DOWNLOAD_MULTIPLIER.mid);
      const unitsHigh = Math.round(reviewDelta * DOWNLOAD_MULTIPLIER.high);

      upsertEstimateStmt().run(
        demo.id, windowKey, asOfDate, reviewCountTotal, reviewDelta,
        unitsLow, unitsMid, unitsHigh, "hellraiser_anchor_v1", "review_delta_multiplier", nowIso,
      );
      rowsWritten += 1;
    }
  }

  log(`demo window estimates computed: demos=${demos.length} rowsWritten=${rowsWritten} asOfDate=${asOfDate}`, "demos-estimator");
  return { demosProcessed: demos.length, rowsWritten };
}
