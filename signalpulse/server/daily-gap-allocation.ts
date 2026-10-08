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
export type AllocationKind = "gap" | "launch" | "rebased_gap";
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
  if (dates.length > (kind === "launch" ? MAX_LAUNCH_DAYS : MAX_GAP_DAYS)) return null;
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

export interface RebaseRow { units: number; signal: number | null; method: string | null }

/**
 * A multi-day gap where the estimator's units-per-signal ratio was reset (LTD units fell although the
 * signal kept growing). The published LTD change is a re-scale, not sales, so it is not allocated. The
 * days' sales are the signal growth at the post-reset ratio, which is exactly how the estimator values
 * every adjacent day after the reset. Fail closed unless: the same estimator method is on both sides,
 * the signal grew, and the next adjacent published pair confirms the ratio within 2%.
 * Returns the units to allocate, or null.
 */
export function rebasedGapUnits(base: RebaseRow, cur: RebaseRow, next: RebaseRow | null): number | null {
  if (!(cur.units - base.units < 0)) return null;
  if (!base.method || !cur.method || base.method.split("+")[0] !== cur.method.split("+")[0]) return null;
  if (base.signal == null || cur.signal == null || !(base.signal > 0) || !(cur.signal > base.signal) || !(cur.units > 0)) return null;
  if (!next || next.signal == null || !(next.signal > cur.signal) || !(next.units >= cur.units)) return null;
  if (next.method?.split("+")[0] !== cur.method.split("+")[0]) return null;
  const r = cur.units / cur.signal;
  const nextR = (next.units - cur.units) / (next.signal - cur.signal);
  if (!Number.isFinite(nextR) || Math.abs(nextR / r - 1) > 0.02) return null;
  return (cur.signal - base.signal) * r;
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

/** Every protection reason that applies to the group, in the order protectionReason checks them. */
export function protectionReasons(db: Database.Database, titleIds: number[]): string[] {
  if (!titleIds.length) return ["no_titles"];
  const ph = titleIds.map(() => "?").join(",");
  const checks: Array<[string, string]> = [
    ["revenue_anchor", `SELECT 1 FROM revenue_calibration_anchors WHERE title_id IN (${ph}) LIMIT 1`],
    ["multiplier_override", `SELECT 1 FROM title_multiplier_overrides WHERE title_id IN (${ph}) LIMIT 1`],
    ["public_milestone", `SELECT 1 FROM steam_unit_milestones WHERE active=1 AND title_id IN (${ph}) LIMIT 1`],
    ["saber_product", `SELECT 1 FROM products p JOIN platform_sku_map m ON m.platform='steam' AND m.external_sku=p.steam_app_id
       WHERE m.title_id IN (${ph}) LIMIT 1`],
  ];
  const out: string[] = [];
  for (const [reason, sql] of checks) {
    try { if (db.prepare(sql).get(...titleIds)) out.push(reason); }
    catch (e: any) { if (!/no such table/i.test(String(e?.message))) return ["check_failed"]; }
  }
  return out;
}

/**
 * Whether the DAILY revenue series may fill gap days and apply the late-joiner rule for this group.
 * An anchor that is a manually verified or publicly reported lifetime figure (data_source `manual_anchor*`) alone does
 * not block it: that anchor fixes lifetime and window totals, while the daily series is a read-side view that only
 * fills days with no value (from the published LTD change, never altering it) and stops a late-listed edition from
 * nulling or spiking earlier days. Anchors from actual sales feeds (Steamworks and the like), any other source, a
 * manual/public multiplier override, an active public unit milestone, a Saber-published product and a failed check
 * all still block. Days that already have a value are never touched.
 * Returns the blocking reason, or null when allocation is allowed.
 */
export function dailyAllocationBlockReason(db: Database.Database, titleIds: number[]): string | null {
  const reasons = protectionReasons(db, titleIds);
  const other = reasons.filter(r => r !== "revenue_anchor");
  if (other.length) return other[0];
  if (!reasons.length) return null;
  const ph = titleIds.map(() => "?").join(",");
  try {
    const nonManual = db.prepare(`SELECT 1 FROM revenue_calibration_anchors WHERE title_id IN (${ph})
      AND COALESCE(data_source,'') NOT LIKE 'manual_anchor%' LIMIT 1`).get(...titleIds);
    return nonManual ? "revenue_anchor" : null;
  } catch { return "check_failed"; }
}

/**
 * Estimator ratio STEP UP on one adjacent day (e.g. the 2026-10-07 Steam multiplier refit, 40.2 to 57.1 units per
 * review). The day-over-day LTD change then holds two things: the day's real sales (signal growth at the new
 * ratio) and a one-time restatement of everything sold before it (prior signal x ratio change). Only the first
 * belongs to the day. Returns both parts, or null unless: same estimator method on both sides, the signal grew,
 * units rose, and the ratio rose by at least `minJump` (default 20%).
 */
export function ratioStepSplit(base: RebaseRow, cur: RebaseRow, minJump = 1.2): { dayUnits: number; restatedUnits: number } | null {
  if (!base.method || !cur.method || base.method.split("+")[0] !== cur.method.split("+")[0]) return null;
  if (base.signal == null || cur.signal == null || !(base.signal > 0) || !(cur.signal > base.signal)) return null;
  if (!(base.units > 0) || !(cur.units > base.units)) return null;
  const rBase = base.units / base.signal, rCur = cur.units / cur.signal;
  if (!(rCur / rBase >= minJump)) return null;
  const dayUnits = (cur.signal - base.signal) * rCur;
  const restatedUnits = (cur.units - base.units) - dayUnits;
  if (!(dayUnits >= 0) || !(restatedUnits > 0)) return null;
  return { dayUnits, restatedUnits };
}

/**
 * Families whose daily series carry the ratio-step restatement spread across their earlier days. Scoped by
 * explicit decision (Steve, 2026-10-08): other titles are not touched by this read-side rule.
 */
/** Earlier ratio changes (launch accumulator starts, the September reset) keep their legacy handling. */
export const RATIO_STEP_SPREAD_FROM = "2026-10-01";
export const RATIO_STEP_SPREAD_FAMILIES: ReadonlySet<string> = new Set(["control resonant", "halloween: the game"]);

/**
 * Spread `restatedRevenue` over the already valued earlier days in proportion to each day's own value, so the
 * existing sales-curve shape is kept and the total is conserved. Null days stay null (nothing is zero-filled).
 */
export function spreadRestatement(daily: Record<string, number | null>, beforeDate: string, restatedRevenue: number): void {
  const days = Object.keys(daily).filter(d => d < beforeDate && typeof daily[d] === "number" && (daily[d] as number) > 0);
  const total = days.reduce((s, d) => s + (daily[d] as number), 0);
  if (!(total > 0) || !(restatedRevenue > 0)) return;
  for (const d of days) daily[d] = (daily[d] as number) + restatedRevenue * ((daily[d] as number) / total);
}

/**
 * Families whose launch week (D1 to D9) is re-shaped by dated Steam review activity. The estimator's first daily
 * rows land after launch, so the first valued days carry a catch-up lump; the lump is real sales, only its timing is
 * wrong. Scoped by decision (Steve, 2026-10-08): Halloween: The Game, D1 = 2026-09-08.
 */
export const LAUNCH_WEEK_REVIEW_FAMILIES: Readonly<Record<string, { start: string; days: number }>> = {
  "halloween: the game": { start: "2026-09-08", days: 9 },
};

/**
 * Re-time the launch week: the days' existing total is redistributed in proportion to `weights` (same length as
 * `days`). The total is conserved exactly; returns false (and changes nothing) unless the weights are complete,
 * non-negative and positive in sum and the existing total is positive. Days outside `days` are never touched.
 */
export function reshapeLaunchWeek(daily: Record<string, number | null>, days: string[], weights: Array<number | undefined>): boolean {
  if (!days.length || weights.length !== days.length) return false;
  if (!weights.every(w => typeof w === "number" && Number.isFinite(w) && w >= 0)) return false;
  const wsum = (weights as number[]).reduce((s, w) => s + w, 0);
  const total = days.reduce((s, d) => s + (typeof daily[d] === "number" ? (daily[d] as number) : 0), 0);
  if (!(wsum > 0) || !(total > 0)) return false;
  days.forEach((d, i) => { daily[d] = total * ((weights[i] as number) / wsum); });
  return true;
}
