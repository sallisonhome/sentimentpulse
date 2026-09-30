/**
 * Global dated-evidence allocation for the raw daily revenue estimator.
 *
 * The raw daily series is the day-over-day change of the published lifetime
 * (LTD) unit estimate. That derivation loses days in two general situations:
 *   1. gap   - a calendar day has no LTD row (a missed daily run), so one row
 *              carries several days of change;
 *   2. launch - the first published LTD value of a title accumulated everything
 *              sold since release, so there is no predecessor to difference.
 * In both cases the published LTD change is authoritative. This module only
 * decides on which days it happened, using dated evidence, and never changes
 * the total. It writes nothing and holds no per-title identity.
 */
import type Database from "better-sqlite3";

export type GapPlatform = "steam" | "ps5" | "xbox";
export type AllocationBasis = "own_ratings" | "steam_review_activity" | "steam_review_activity_lag1" | "steam_activity_shape";
export type AllocationKind = "gap" | "launch";
export interface SeriesRow { date: string; units: number | null; signal: number | null }
export interface GapEvidence {
  releaseDate: string | null;
  ratings: Record<GapPlatform, Map<string, number>>;
  steamDaily: Map<string, number>;
  steamRatings: Map<string, number>;
}
export interface Allocation { kind: AllocationKind; basis: AllocationBasis; units: Map<string, number> }

export const MAX_GAP_DAYS = 7;
export const MAX_LAUNCH_DAYS = 14;
export const REVIEW_LAG_DAYS = 1;
export const EARLY_ACCESS_DAYS = 7;
const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);

export function allocationEnabled(db: Database.Database): boolean {
  if (process.env.DAILY_GAP_ALLOCATION_ENABLED === "0") return false;
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='daily_gap_allocation_enabled'").get() as { value?: string } | undefined;
    return row?.value !== "0";
  } catch { return true; }
}

export function loadGapEvidence(db: Database.Database, titleIds: number[]): GapEvidence {
  const empty: GapEvidence = {
    releaseDate: null,
    ratings: { steam: new Map(), ps5: new Map(), xbox: new Map() },
    steamDaily: new Map(), steamRatings: new Map(),
  };
  if (!titleIds.length) return empty;
  const ph = titleIds.map(() => "?").join(",");
  const rat = db.prepare(`
    SELECT platform, capture_date AS d, rating_count AS n FROM store_rating_signal_daily
     WHERE title_id IN (${ph}) AND rating_count IS NOT NULL AND capture_date>='2026-09-01'
     ORDER BY capture_date, created_at`).all(...titleIds) as Array<{ platform: GapPlatform; d: string; n: number }>;
  for (const r of rat) if (empty.ratings[r.platform] && Number.isFinite(r.n) && r.n >= 0) empty.ratings[r.platform].set(r.d, r.n);
  empty.steamRatings = empty.ratings.steam;
  const apps = db.prepare(`SELECT DISTINCT external_sku AS app FROM platform_sku_map WHERE platform='steam' AND title_id IN (${ph})`)
    .all(...titleIds) as Array<{ app: string }>;
  if (apps.length === 1) {
    const rows = db.prepare(`
      SELECT bucket_start AS b, recommendations_up AS u, recommendations_down AS dn FROM steam_review_history
       WHERE app_id=? AND bucket_granularity='day' ORDER BY bucket_start, rowid`).all(apps[0].app) as Array<{ b: number; u: number; dn: number }>;
    for (const r of rows) {
      if (!Number.isFinite(r.b) || r.b % 86400 !== 0 || !(r.u >= 0) || !(r.dn >= 0)) continue;
      empty.steamDaily.set(iso(r.b * 1000), r.u + r.dn);
    }
  }
  const rel = db.prepare(`
    SELECT release_date AS a, store_release_date AS b FROM console_title_igdb WHERE title_id IN (${ph})`).all(...titleIds) as Array<{ a: string | null; b: string | null }>;
  const dates = rel.flatMap(r => [r.a, r.b]).filter((d): d is string => !!d && ISO.test(d)).sort();
  empty.releaseDate = dates[0] ?? null;
  return empty;
}

function spanWeights(kind: AllocationKind, platform: GapPlatform, dates: string[], baseDate: string, baseZero: boolean, ev: GapEvidence): { basis: AllocationBasis; w: number[] } | null {
  const k = dates.length;
  const positive = (w: number[]) => w.every(x => Number.isFinite(x) && x >= 0) && w.reduce((s, x) => s + x, 0) > 0;
  // Saber's own Steamworks actuals show reviews trail purchases: for Twisted Tower's 2026-08-18
  // launch, same-day review shares misallocate 21-34% of units across days, while next-day review
  // shares misallocate 3-9%. A launch seed therefore weights each day by the following day's
  // reviews when every such bucket is stored.
  const steamLagged = (): number[] | null => {
    const next = dates.map(d => addDays(d, REVIEW_LAG_DAYS));
    if (!next.every(d => ev.steamDaily.has(d))) return null;
    const w = next.map(d => ev.steamDaily.get(d)!);
    return positive(w) ? w : null;
  };
  const steamActivity = (): number[] | null => {
    if (!dates.every(d => ev.steamDaily.has(d))) return null;
    const w = dates.map(d => ev.steamDaily.get(d)!);
    if (platform === "steam") {
      const start = baseZero ? 0 : ev.steamRatings.get(baseDate);
      const end = ev.steamRatings.get(dates[k - 1]);
      if (start != null && end != null) {
        const last = end - start - w.slice(0, -1).reduce((s, x) => s + x, 0);
        if (last >= 0) w[k - 1] = last;
      }
    }
    return positive(w) ? w : null;
  };
  const ownRatings = (): number[] | null => {
    const own = ev.ratings[platform];
    let prev = baseZero ? 0 : own.get(baseDate);
    if (prev == null) return null;
    const w: number[] = [];
    for (const d of dates) {
      const cur = own.get(d);
      if (cur == null || cur < prev) return null;
      w.push(cur - prev);
      prev = cur;
    }
    return positive(w) ? w : null;
  };
  const order: Array<[AllocationBasis, () => number[] | null]> = platform === "steam"
    ? [...(kind === "launch" ? [["steam_review_activity_lag1", steamLagged] as [AllocationBasis, () => number[] | null]] : []),
       ["steam_review_activity", steamActivity], ["own_ratings", ownRatings]]
    : [["own_ratings", ownRatings], ["steam_activity_shape", steamActivity]];
  for (const [basis, fn] of order) { const w = fn(); if (w) return { basis, w }; }
  return null;
}

/** Allocate `units` (a non-negative LTD change) across `dates` (ascending, contiguous, ending at the observed row). */
export function allocateSpan(platform: GapPlatform, kind: AllocationKind, dates: string[], units: number, baseDate: string, baseZero: boolean, ev: GapEvidence): Allocation | null {
  if (!dates.length || !(units >= 0) || !Number.isFinite(units)) return null;
  if (dates.length > (kind === "gap" ? MAX_GAP_DAYS : MAX_LAUNCH_DAYS)) return null;
  const sw = spanWeights(kind, platform, dates, baseDate, baseZero, ev);
  if (!sw) return null;
  // A launch needs the platform's own dated evidence. Borrowed shapes are only
  // acceptable between two real observations (gap), never to invent when a platform launched.
  if (kind === "launch" && sw.basis !== "own_ratings" && !sw.basis.startsWith("steam_review_activity")) return null;
  if (kind === "launch" && platform !== "steam" && sw.basis.startsWith("steam_review_activity")) return null;
  const total = sw.w.reduce((s, x) => s + x, 0);
  const out = new Map<string, number>();
  let assigned = 0;
  dates.forEach((d, i) => {
    const v = i === dates.length - 1 ? units - assigned : units * sw.w[i] / total;
    assigned += v;
    out.set(d, Math.max(0, v));
  });
  return { kind, basis: sw.basis, units: out };
}

/**
 * Zero baseline for a title with no earlier published LTD: the latest earlier row that records zero
 * signal, otherwise the day before release. Returns null when neither is known (no launch reconstruction).
 */
export function launchBaseline(rows: SeriesRow[], firstIdx: number, ev: GapEvidence, platform: GapPlatform): string | null {
  const first = rows[firstIdx];
  // A launch is corroborated by a release date shortly before (or, for early access, just after) the
  // first published value. An old title that merely appears in the catalog is not a launch.
  const rel = ev.releaseDate;
  if (!rel) return null;
  const sinceRelease = (ms(first.date) - ms(rel)) / DAY;
  if (sinceRelease < -EARLY_ACCESS_DAYS || sinceRelease > MAX_LAUNCH_DAYS) return null;
  for (let i = firstIdx - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.signal === 0 && r.units == null) return r.date;
    if (ev.ratings[platform].get(r.date) === 0) return r.date;
  }
  return rel <= first.date ? addDays(rel, -1) : null;
}

/**
 * A multi-day LTD change is only allocated when the platform's own signal (rating or review count)
 * grew enough to explain it at the title's current units-per-signal ratio. Re-basing jumps (method
 * flips, seeded lifetimes, catalog repairs) are not sales and stay empty.
 */
export function changeExplainedBySignal(deltaUnits: number, baseSignal: number | null, curSignal: number | null, curUnits: number): boolean {
  if (!(deltaUnits >= 0) || baseSignal == null || curSignal == null || !(curSignal > 0) || !(curUnits > 0)) return false;
  const growth = curSignal - baseSignal;
  if (growth < 0) return false;
  return deltaUnits <= 3 * growth * (curUnits / curSignal) + 100;
}

/**
 * Titles whose sales are anchored to actual or publicly reported data are never reallocated:
 * revenue calibration anchors, manual/public multiplier overrides, active public unit milestones,
 * and Saber-published products with Steamworks sales. Any unexpected check failure also protects.
 * Returns the reason the group is protected, or null.
 */
export function protectionReason(db: Database.Database, titleIds: number[]): string | null {
  if (!titleIds.length) return "no_titles";
  const ph = titleIds.map(() => "?").join(",");
  const checks: Array<[string, string]> = [
    ["revenue_anchor", `SELECT 1 FROM revenue_calibration_anchors WHERE title_id IN (${ph}) LIMIT 1`],
    ["multiplier_override", `SELECT 1 FROM title_multiplier_overrides WHERE title_id IN (${ph}) LIMIT 1`],
    ["public_milestone", `SELECT 1 FROM steam_unit_milestones WHERE active=1 AND title_id IN (${ph}) LIMIT 1`],
    ["saber_product", `SELECT 1 FROM products p JOIN platform_sku_map m ON m.platform='steam' AND m.external_sku=p.steam_app_id
       WHERE m.title_id IN (${ph}) LIMIT 1`],
  ];
  for (const [reason, sql] of checks) {
    try { if (db.prepare(sql).get(...titleIds)) return reason; }
    catch (e: any) { if (!/no such table/i.test(String(e?.message))) return "check_failed"; }
  }
  return null;
}
