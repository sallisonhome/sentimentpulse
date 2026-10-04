// Chart-consistency pass for the console leaderboards (PS5, Xbox).
//
// The storefront sales chart is the first source of truth for ordering. A ratings-derived or Steam-overlay
// estimate must not sit above the titles that chart above it, or below the titles that chart below it.
// Each non-anchored title is compared with the units of its nearest charted neighbours (anchored and
// actual rows count as references but are never moved) and moved to the bound only when it falls outside.
//
// Modes (env CHART_CONSISTENCY_MODE): "off" | "report" (default; annotates rows, changes nothing) | "enforce".
// Chart rank is the title-level rank written by discovery (chartRank.ts): paid titles only, SKUs combined.
// Only d7 and d30 are touched: the chart is a 30-day chart, and LTD/d90/m12 keep their own anchoring.

import { combineChartSlots } from "./signals/console/chartRank";

export const CHART_NEIGHBOURS = 5;
export const CHART_TOLERANCE = 1.5;     // neighbours' median may be off by this factor before we move a row
export const CHART_MAX_RAISE = 3;       // never raise a row more than 3x on chart evidence alone (chart metric not yet calibrated)
export const CHART_MIN_RANKED = 50;     // skip entirely when the snapshot is thin
const EXEMPT_SOURCES = new Set([
  "actual", "native_public_ceiling", "scaled_to_verified_ltd_anchor_units", "scaled_to_verified_ltd_anchor",
  "estimated_public_unit_milestone", "estimated_public_ceiling", "unavailable",
]);

export type ChartMode = "off" | "report" | "enforce";
export function chartModeFromEnv(v: string | undefined): ChartMode {
  const m = (v ?? "report").toLowerCase();
  return m === "off" || m === "enforce" ? m : "report";
}

export interface ChartGroup {
  familyTitleIds: number[];
  dataSource?: string | null;
  estimateMethod?: string | null;
  unitsMid: number | null;
  revenueMidUsd: number | null;
  ownersMid?: number | null;
  verifiedAnchorUnits?: number | null;
  [k: string]: unknown;
}
export interface ChartNote {
  chartRank: number | null; before: number; after: number; bound: "ceiling" | "floor" | "off_chart_cap" | "deep_rank_ceiling" | "launch_window_protected";
  applied: boolean; neighbours: number;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

export function groupChartRank(g: ChartGroup, rankByTitle: Map<number, number>): number | null {
  const slots = g.familyTitleIds.filter(id => rankByTitle.has(id)).map(id => ({ titleId: 0, storefrontRank: rankByTitle.get(id)! }));
  return slots.length ? combineChartSlots(slots)[0].rank : null;
}

export function isChartExempt(g: ChartGroup, overrideTitleIds: Set<number>): boolean {
  if (g.verifiedAnchorUnits != null) return true;
  if (g.dataSource && EXEMPT_SOURCES.has(g.dataSource)) return true;
  if (String(g.estimateMethod ?? "").startsWith("override")) return true;
  return g.familyTitleIds.some(id => overrideTitleIds.has(id));
}

/** Annotates (report) or adjusts (enforce) groups in place. Returns the rows it would move / moved. */
export const CHART_LAUNCH_WINDOW_DAYS = 7;

/** Pre-order, early access and launch week: the storefront chart is incomplete for these (e.g. a standard pre-order SKU
 *  that does not chart while the premium SKU does), so chart evidence must not move the estimate. */
export function inLaunchWindow(releaseDate: unknown, today: string): boolean {
  if (typeof releaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(releaseDate)) return false;
  const rel = Date.parse(releaseDate.slice(0, 10) + "T00:00:00Z"), now = Date.parse(today + "T00:00:00Z");
  return Number.isFinite(rel) && Number.isFinite(now) && now - rel < CHART_LAUNCH_WINDOW_DAYS * 86400000;
}

export const DEEP_FIT_MIN_REFS = 20;
export interface DeepCurve { a: number; b: number; n: number; r2: number }

/** Log-log least squares of units on chart rank over the reference rows: units = exp(a) * rank^b. Null when the data
 *  cannot support a sensible curve (too few points, flat or rising, or an absurd slope). */
export function fitRankCurve(points: Array<{ rank: number; units: number }>): DeepCurve | null {
  const first = fitOnce(points);
  if (!first) return null;
  // One trimming pass: drop reference rows more than 2x above or below the first curve (these are the rows the pass is
  // about to flag, and they would drag the curve toward themselves), then refit. Keep the first fit if too few remain.
  const kept = points.filter(x => x.rank >= 1 && x.units > 0 && x.units <= 2 * curveUnits(first, x.rank) && x.units >= curveUnits(first, x.rank) / 2);
  return fitOnce(kept) ?? first;
}
function fitOnce(points: Array<{ rank: number; units: number }>): DeepCurve | null {
  const p = points.filter(x => x.rank >= 1 && x.units > 0);
  if (p.length < DEEP_FIT_MIN_REFS) return null;
  const xs = p.map(x => Math.log(x.rank)), ys = p.map(x => Math.log(x.units));
  const mx = xs.reduce((a, b) => a + b, 0) / p.length, my = ys.reduce((a, b) => a + b, 0) / p.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  if (!(b < -0.2 && b > -2.5)) return null;
  const a = my - b * mx;
  const sst = ys.reduce((acc, y) => acc + (y - my) ** 2, 0);
  const sse = xs.reduce((acc, x, i) => acc + (ys[i] - (a + b * x)) ** 2, 0);
  return { a, b, n: p.length, r2: sst > 0 ? 1 - sse / sst : 0 };
}
export const curveUnits = (c: DeepCurve, rank: number) => Math.exp(c.a) * Math.pow(rank, c.b);

export interface ChartOptions {
  /** Paid-only deep chart rank per title id (newest deep snapshot). Titles below the stored top ranks get a rank-based
   *  ceiling from a curve fitted on today's reference rows, instead of one flat off-chart cap. Never raises an estimate. */
  deepRankByTitle?: Map<number, number>;
  /** Override of CHART_MIN_RANKED (tests and offline replays only). */
  minRanked?: number;
  /** YYYY-MM-DD used by the launch-window guard (defaults to today, UTC). */
  today?: string;
  /** Extra protection, e.g. a configured public sales ceiling for the title family. */
  extraExempt?: (g: ChartGroup) => boolean;
  /** Title ids charted on ANY of the last few snapshots. Only titles absent from all of them are treated as off-chart. */
  recentlyCharted?: Set<number>;
}

export const CHART_MAX_PASSES = 4;

interface Decision { g: ChartGroup; rank: number | null; target: number; bound: ChartNote["bound"]; nb: number; deepRank: number | null }

export function applyChartConsistency(
  groups: ChartGroup[], rankByTitle: Map<number, number>, overrideTitleIds: Set<number>, mode: ChartMode, opts: ChartOptions = {},
): { moved: number; capped: number; protectedLaunch: number; skipped: string | null } {
  if (mode === "off") return { moved: 0, capped: 0, protectedLaunch: 0, skipped: "off" };
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const exempt = (g: ChartGroup) => isChartExempt(g, overrideTitleIds) || !!opts.extraExempt?.(g);
  const allRefs = groups
    .map(g => ({ g, rank: groupChartRank(g, rankByTitle), units: g.unitsMid }))
    .filter((x): x is { g: ChartGroup; rank: number; units: number } => x.rank != null && x.units != null && x.units > 0)
    .sort((a, b) => a.rank - b.rank);
  if (allRefs.length < (opts.minRanked ?? CHART_MIN_RANKED)) return { moved: 0, capped: 0, protectedLaunch: 0, skipped: `thin_chart(${allRefs.length})` };
  // Launch-week titles are never moved, so their own estimate is unreliable and the chart is incomplete for them:
  // they must not serve as a reference for their neighbours either (unless exempt, e.g. an anchored actual).
  const refs = allRefs.filter(r => exempt(r.g) || !inLaunchWindow(r.g.releaseDate, today));

  // The bound for a title is computed from its neighbours' values AFTER the same pass has adjusted them, found by
  // iterating to a fixed point. Every pass reads only the previous pass's values, so the result does not depend on row
  // order. A neighbour that is itself cut (or raised) therefore no longer anchors its neighbours to a value it is about
  // to lose. Capped at CHART_MAX_PASSES; the last pass is used if the values are still moving.
  const decide = (work: Map<ChartGroup, number>): Map<ChartGroup, Decision> => {
    const out = new Map<ChartGroup, Decision>();
    const unitsOf = (r: { g: ChartGroup }) => work.get(r.g)!;
    const deepest = refs.slice(-CHART_NEIGHBOURS).map(unitsOf);
    const curve = opts.deepRankByTitle && opts.deepRankByTitle.size > 0 ? fitRankCurve(refs.map(r => ({ rank: r.rank, units: unitsOf(r) }))) : null;
    for (const g of groups) {
      if (g.unitsMid == null || g.unitsMid <= 0) continue;
      if (exempt(g)) continue;
      const rank = groupChartRank(g, rankByTitle);
      let target: number | null = null; let bound: ChartNote["bound"] = "ceiling"; let nb = 0; let deepRank: number | null = null;
      if (rank == null) {
        // A title that charted on a recent snapshot but is missing today may be a one-day miss or an ID-mapping gap:
        // never cap it. Only titles absent from every recent snapshot count as off-chart.
        if (opts.recentlyCharted && g.familyTitleIds.some(id => opts.recentlyCharted!.has(id))) continue;
        target = CHART_TOLERANCE * median(deepest); bound = "off_chart_cap"; nb = deepest.length;
        // A deep paid rank (below the top-ranked set) gives a rank-based ceiling; it can only lower the flat cap, never raise it.
        const deepRanks = curve ? g.familyTitleIds.map(id => opts.deepRankByTitle!.get(id)).filter((v): v is number => v != null) : [];
        if (curve && deepRanks.length > 0) {
          const dr = Math.min(...deepRanks);
          const byRank = CHART_TOLERANCE * curveUnits(curve, dr);
          if (byRank < target) { target = byRank; bound = "deep_rank_ceiling"; nb = curve.n; deepRank = dr; }
        }
        if (!(g.unitsMid > target)) target = null;
      } else {
        const above = refs.filter(r => r.rank < rank && r.g !== g).slice(-CHART_NEIGHBOURS);
        const below = refs.filter(r => r.rank > rank && r.g !== g).slice(0, CHART_NEIGHBOURS);
        if (above.length >= 3) {
          const ceil = CHART_TOLERANCE * median(above.map(unitsOf));
          if (g.unitsMid > ceil) { target = ceil; bound = "ceiling"; nb = above.length; }
        }
        if (target == null && below.length >= 3) {
          const floor = Math.min(median(below.map(unitsOf)) / CHART_TOLERANCE, CHART_MAX_RAISE * g.unitsMid);
          if (g.unitsMid < floor) { target = floor; bound = "floor"; nb = below.length; }
        }
      }
      if (target == null) continue;
      out.set(g, { g, rank, target, bound, nb, deepRank });
    }
    return out;
  };

  let work = new Map<ChartGroup, number>(refs.map(r => [r.g, r.units]));
  let decisions = decide(work);
  for (let pass = 1; pass < CHART_MAX_PASSES; pass++) {
    const next = new Map(work);
    for (const d of Array.from(decisions.values())) if (next.has(d.g) && !inLaunchWindow(d.g.releaseDate, today)) next.set(d.g, Math.round(d.target));
    let changed = false;
    next.forEach((u, g) => { if (Math.abs(u - work.get(g)!) >= 1) changed = true; });
    if (!changed) break;
    work = next; decisions = decide(work);
  }

  let moved = 0, capped = 0, protectedLaunch = 0;
  for (const d of Array.from(decisions.values())) {
    const g = d.g;
    const before = g.unitsMid!; const after = Math.round(d.target); const f = after / before;
    if (inLaunchWindow(g.releaseDate, today)) {
      // Shown so the contradiction is visible, but never applied: the chart is incomplete for pre-order / launch-week titles.
      g.chartConsistency = { chartRank: d.rank, before, after, bound: "launch_window_protected", applied: false, neighbours: d.nb } as ChartNote;
      protectedLaunch++;
      continue;
    }
    const note: ChartNote = { chartRank: d.rank, before, after, bound: d.bound, applied: mode === "enforce", neighbours: d.nb };
    if (d.deepRank != null) (note as any).deepPaidRank = d.deepRank;
    g.chartConsistency = note;
    if (d.bound === "off_chart_cap" || d.bound === "deep_rank_ceiling") capped++; else moved++;
    if (mode === "enforce") {
      g.unitsMid = after;
      if (g.revenueMidUsd != null) g.revenueMidUsd = g.revenueMidUsd * f;
      if (g.ownersMid != null) g.ownersMid = Math.round(g.ownersMid * f);
      g.estimateMethod = `${g.estimateMethod ?? g.dataSource ?? "est"}+chart_consistency_v1`;
    }
  }
  return { moved, capped, protectedLaunch, skipped: null };
}
