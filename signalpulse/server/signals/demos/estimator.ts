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
 * estimator stores a provisional central estimate plus sensitivity
 * values (not confidence bounds). The UI shows the central estimate,
 * except when the shared concurrency consistency resolver identifies
 * a contradiction and substitutes an explicitly labeled observed minimum.
 * No new global or genre multiplier is fitted without matched ground truth.
 *
 * License activations and complimentary units are not download actuals;
 * that collector remains disabled. Legacy actual rows remain protected.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { DEMO_DOWNLOAD_MULTIPLIER, demoDownloadMultiplier } from "./download-consistency";

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
export const DOWNLOAD_MULTIPLIER = DEMO_DOWNLOAD_MULTIPLIER;

interface DemoTitleForEstimate {
  id: number;
  steam_app_id: string;
  first_seen_at: string;
  is_saber_published: number;
}

function loadEstimableDemos(): DemoTitleForEstimate[] {
  return rawSqlite
    .prepare(`SELECT id, steam_app_id, first_seen_at, is_saber_published
      FROM demo_titles WHERE is_active = 1`)
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
  const buckets = rawSqlite.prepare(`SELECT bucket_start AS start,bucket_granularity AS grain,
    recommendations_up+recommendations_down AS count,created_at AS seen
    FROM steam_review_history WHERE app_id=?`).all(appId) as ReviewBucket[];
  return sumNonOverlappingReviews(buckets, windowStartUnix);
}

interface ReviewBucket {start:number;grain:string;count:number;seen:string}
/** Use one lifetime representation and never add recent days that overlap it.
 * Window boundaries are bucket-based (no invented daily prorating for older
 * weekly/monthly data). Daily buckets fill only periods not covered by a
 * selected rollup. Lifetime sums therefore agree with the review summary.
 */
export function sumNonOverlappingReviews(buckets: ReviewBucket[], start: number | null): number {
  const rollups = buckets.filter(b=>["week","month"].includes(b.grain));
  const newest = (grain:string)=>rollups.filter(b=>b.grain===grain).reduce((v,b)=>b.seen>v?b.seen:v,"");
  const grain = newest("month") >= newest("week") ? "month" : "week";
  const selected = rollups.filter(b=>b.grain===grain && (start===null || b.start>=start));
  const end = (b:ReviewBucket) => b.grain==="week" ? b.start+7*86400
    : Date.UTC(new Date(b.start*1000).getUTCFullYear(),new Date(b.start*1000).getUTCMonth()+1,1)/1000;
  const daily = buckets.filter(b=>b.grain==="day" && (start===null || b.start>=start) &&
    !selected.some(r=>b.start>=r.start && b.start<end(r)));
  return selected.concat(daily).reduce((total,b)=>total+b.count,0);
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
export function computeDemoWindowEstimates(asOfDate = new Date().toISOString().slice(0, 10), eligibleAppIds?: ReadonlySet<string>): DemoEstimateRunResult {
  const demos = loadEstimableDemos().filter(d => !eligibleAppIds || eligibleAppIds.has(d.steam_app_id));
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

      const saber = demo.is_saber_published === 1;
      const unitsLow = saber ? Math.round(reviewDelta * DOWNLOAD_MULTIPLIER.low) : null;
      const unitsMid = Math.round(reviewDelta * demoDownloadMultiplier(saber));
      const unitsHigh = saber ? Math.round(reviewDelta * DOWNLOAD_MULTIPLIER.high) : null;

      upsertEstimateStmt().run(
        demo.id, windowKey, asOfDate, reviewCountTotal, reviewDelta,
        unitsLow, unitsMid, unitsHigh, saber ? "hellraiser_anchor_v1" : "non_saber_trial_130_v1", "review_delta_multiplier", nowIso,
      );
      rowsWritten += 1;
    }
  }

  log(`demo window estimates computed: demos=${demos.length} rowsWritten=${rowsWritten} asOfDate=${asOfDate}`, "demos-estimator");
  return { demosProcessed: demos.length, rowsWritten };
}
