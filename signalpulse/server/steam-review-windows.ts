/** Paid-sales review evidence. Raw buckets are retained; only the read is de-duplicated. */
export const STEAM_HISTOGRAM_VERSION = "steam_histogram_nonoverlap_v1";
const DAY = 86400;
export type ReviewBucket = {
  bucket_start: number;
  bucket_granularity: string;
  recommendations_up: number;
  recommendations_down: number;
  created_at?: string;
};
export type HistogramWindow = {
  signal: number | null;
  selectedBuckets: number;
  discardedOverlaps: number;
  coarseBoundary: boolean;
};
export function utcWindowBounds(asOfDate: string, days: number | null) {
  const today = Date.parse(`${asOfDate}T00:00:00Z`) / 1000;
  if (!Number.isFinite(today) || new Date(today * 1000).toISOString().slice(0, 10) !== asOfDate) {
    throw new Error(`Invalid as-of date: ${asOfDate}`);
  }
  return { start: days == null ? -Infinity : today - (days - 1) * DAY, end: today + DAY };
}
function bucketEnd(b: ReviewBucket) {
  if (b.bucket_granularity === "day") return b.bucket_start + DAY;
  if (b.bucket_granularity === "week") return b.bucket_start + 7 * DAY;
  const d = new Date(b.bucket_start * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}
/**
 * Prefer complete daily replacements; otherwise use ONE current rollup grain.
 * Daily rows covered by a retained rollup are never added again. Historical
 * edges remain bucket-start based, explicitly coarse, never prorated into
 * invented daily observations. Missing history is null, observed zero is zero.
 */
export function reviewWindow(
  input: ReviewBucket[], asOfDate: string, days: number | null, preferredGrain?: string,
): HistogramWindow {
  const { start, end } = utcWindowBounds(asOfDate, days);
  const empty = { signal: null, selectedBuckets: 0, discardedOverlaps: 0, coarseBoundary: false };
  const rows = input.filter(b => ["day", "week", "month"].includes(b.bucket_granularity) &&
    Number.isFinite(b.bucket_start) && b.bucket_start < end);
  if (!rows.length) return empty;
  if (rows.some(b => !Number.isSafeInteger(b.recommendations_up) || b.recommendations_up < 0 ||
    !Number.isSafeInteger(b.recommendations_down) || b.recommendations_down < 0)) return empty;
  const unique = new Map<string, ReviewBucket>();
  for (const b of rows) {
    const key = `${b.bucket_granularity}:${b.bucket_start}`, old = unique.get(key);
    // Conflicting duplicates are corrupt evidence, not an opportunity to add.
    if (old && (old.recommendations_up !== b.recommendations_up ||
      old.recommendations_down !== b.recommendations_down)) return empty;
    unique.set(key, b);
  }
  const all = Array.from(unique.values());
  const daily = all.filter(b => b.bucket_granularity === "day");
  const dayMap = new Map(daily.map(b => [b.bucket_start, b]));
  const grains = ["week", "month"].filter(g => all.some(b => b.bucket_granularity === g));
  const newest = (g: string) => Math.max(...all.filter(b => b.bucket_granularity === g).map(b => b.bucket_start));
  const grain = grains.includes(preferredGrain ?? "") ? preferredGrain :
    grains.sort((a, b) => newest(b) - newest(a) || b.localeCompare(a))[0];
  const coarse = all.filter(b => b.bucket_granularity === grain).sort((a, b) => a.bucket_start - b.bucket_start);
  const retained: Array<{ bucket: ReviewBucket; end: number }> = [];
  let discardedOverlaps = all.length - daily.length - coarse.length;
  let coarseBoundary = false;
  for (let i = 0; i < coarse.length; i++) {
    const b = coarse[i], stop = Math.min(bucketEnd(b), end, coarse[i + 1]?.bucket_start ?? Infinity);
    // Test the WHOLE observed bucket, not only its intersection with the window.
    let completeDaily = true;
    for (let t = b.bucket_start; t < stop; t += DAY) if (!dayMap.has(t)) { completeDaily = false; break; }
    if (completeDaily) { discardedOverlaps++; continue; }
    if (b.bucket_start < start) {
      if (stop > start) coarseBoundary = true;
      continue;
    }
    retained.push({ bucket: b, end: stop });
  }
  const pickedDaily = daily.filter(b => b.bucket_start >= start &&
    !retained.some(r => b.bucket_start >= r.bucket.bucket_start && b.bucket_start < r.end));
  discardedOverlaps += daily.filter(b => b.bucket_start >= start).length - pickedDaily.length;
  const picked = pickedDaily.concat(retained.map(r => r.bucket));
  // No bucket in the window is not proof of zero reviews.
  if (!picked.length) return { ...empty, discardedOverlaps, coarseBoundary };
  return {
    signal: picked.reduce((s, b) => s + b.recommendations_up + b.recommendations_down, 0),
    selectedBuckets: picked.length, discardedOverlaps,
    coarseBoundary: coarseBoundary || retained.length > 0,
  };
}
