// Owner-driven review surges (free upgrades and re-releases) are not sales.
// A paid-sales estimate built from new reviews overstates them. This guard is
// read-time only: it replaces surge reviews with the title's own recent baseline.
// It never touches stored history, anchors, overrides or milestones.
export const REVIEW_SURGE_VERSION = "steam_review_surge_guard_v1";
export const SURGE_WINDOWS: Record<string, number> = { d7: 7, d30: 30 };
const TRAILING_DAYS = 7, SURGE_DAY_MULT = 2;
const DAY = 86400;
export type DayBucket = { start: number; up: number; down: number };
export interface SurgeResult {
  flagged: boolean; reason: string;
  windowReviews?: number; baselineReviews?: number; ratio?: number;
  negShare?: number; baseNegShare?: number; scale?: number;
}
const BASELINE_DAYS = 21, MIN_BASELINE_DAYS = 15, RATIO = 3, MIN_REVIEWS_PER_DAY = 214, NEG_FLOOR = 0.15, NEG_MULT = 3;

/**
 * asOfDate is the last day of the window (inclusive), YYYY-MM-DD, as the estimator uses it.
 * A surge is judged on the trailing 7 days, so a 30-day window that contains it is also
 * caught. The scale replaces only the surge days (over 2x the daily baseline, inside the
 * trailing 14 days) with the daily baseline, and keeps every other day as observed.
 */
export function detectReviewSurge(buckets: DayBucket[], asOfDate: string, days: number): SurgeResult {
  const end = Date.parse(`${asOfDate}T00:00:00Z`) / 1000;
  if (!Number.isFinite(end) || !(days > 0)) return { flagged: false, reason: "bad_input" };
  const byDay = new Map<number, DayBucket>();
  for (const b of buckets) {
    if (![b.start, b.up, b.down].every(Number.isFinite) || b.up < 0 || b.down < 0) return { flagged: false, reason: "invalid_history" };
    byDay.set(b.start, b);
  }
  const tStart = end - (TRAILING_DAYS - 1) * DAY, wStart = end - (days - 1) * DAY;
  const bStart = Math.min(tStart, wStart) - BASELINE_DAYS * DAY;
  // The window and the trailing week must be fully observed: a missing day is unknown, not zero.
  let win = 0, tr = 0, trDown = 0;
  for (let t = Math.min(tStart, wStart); t <= end; t += DAY) {
    const b = byDay.get(t);
    if (!b) return { flagged: false, reason: "incomplete_window" };
    if (t >= wStart) win += b.up + b.down;
    if (t >= tStart) { tr += b.up + b.down; trDown += b.down; }
  }
  let n = 0, base = 0, baseDown = 0;
  for (let t = bStart; t < Math.min(tStart, wStart); t += DAY) {
    const b = byDay.get(t);
    if (b) { n++; base += b.up + b.down; baseDown += b.down; }
  }
  if (n < MIN_BASELINE_DAYS) return { flagged: false, reason: "insufficient_baseline" };
  const baseDaily = base / n, baselineReviews = baseDaily * TRAILING_DAYS;
  const ratio = baselineReviews > 0 ? tr / baselineReviews : Infinity;
  const negShare = tr ? trDown / tr : 0, baseNegShare = base ? baseDown / base : 0;
  const out = { windowReviews: win, baselineReviews, ratio, negShare, baseNegShare };
  if (tr < MIN_REVIEWS_PER_DAY * TRAILING_DAYS) return { flagged: false, reason: "below_volume", ...out };
  if (!(ratio >= RATIO)) return { flagged: false, reason: "no_surge", ...out };
  // A sale or launch raises positives and negatives together. Owner reaction to a
  // free upgrade lifts the negative share. Require both.
  if (!(negShare >= Math.max(NEG_FLOOR, NEG_MULT * baseNegShare))) return { flagged: false, reason: "surge_without_negative_jump", ...out };
  let adjusted = 0;
  for (let t = wStart; t <= end; t += DAY) {
    const tot = byDay.get(t)!.up + byDay.get(t)!.down;
    const inSurgeZone = t >= end - 13 * DAY;
    adjusted += inSurgeZone && tot > SURGE_DAY_MULT * baseDaily ? baseDaily : tot;
  }
  return { flagged: true, reason: "owner_review_surge", ...out, scale: win > 0 ? Math.min(1, adjusted / win) : 1 };
}
