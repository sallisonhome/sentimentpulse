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
  chartRank: number | null; before: number; after: number; bound: "ceiling" | "floor" | "off_chart_cap" | "launch_window_protected";
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

export interface ChartOptions {
  /** YYYY-MM-DD used by the launch-window guard (defaults to today, UTC). */
  today?: string;
  /** Extra protection, e.g. a configured public sales ceiling for the title family. */
  extraExempt?: (g: ChartGroup) => boolean;
  /** Title ids charted on ANY of the last few snapshots. Only titles absent from all of them are treated as off-chart. */
  recentlyCharted?: Set<number>;
}

export function applyChartConsistency(
  groups: ChartGroup[], rankByTitle: Map<number, number>, overrideTitleIds: Set<number>, mode: ChartMode, opts: ChartOptions = {},
): { moved: number; capped: number; protectedLaunch: number; skipped: string | null } {
  if (mode === "off") return { moved: 0, capped: 0, protectedLaunch: 0, skipped: "off" };
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const refs = groups
    .map(g => ({ g, rank: groupChartRank(g, rankByTitle), units: g.unitsMid }))
    .filter((x): x is { g: ChartGroup; rank: number; units: number } => x.rank != null && x.units != null && x.units > 0)
    .sort((a, b) => a.rank - b.rank);
  if (refs.length < CHART_MIN_RANKED) return { moved: 0, capped: 0, protectedLaunch: 0, skipped: `thin_chart(${refs.length})` };
  const baseUnits = new Map(refs.map(r => [r.g, r.units]));   // references use PRE-adjustment values
  const deepest = refs.slice(-CHART_NEIGHBOURS).map(r => r.units);
  let moved = 0, capped = 0, protectedLaunch = 0;

  for (const g of groups) {
    if (g.unitsMid == null || g.unitsMid <= 0) continue;
    if (isChartExempt(g, overrideTitleIds) || opts.extraExempt?.(g)) continue;
    const rank = groupChartRank(g, rankByTitle);
    let target: number | null = null; let bound: ChartNote["bound"] = "ceiling"; let nb = 0;
    if (rank == null) {
      // A title that charted on a recent snapshot but is missing today may be a one-day miss or an ID-mapping gap:
      // never cap it. Only titles absent from every recent snapshot count as off-chart.
      if (opts.recentlyCharted && g.familyTitleIds.some(id => opts.recentlyCharted!.has(id))) continue;
      target = CHART_TOLERANCE * median(deepest); bound = "off_chart_cap"; nb = deepest.length;
      if (!(g.unitsMid > target)) target = null;
    } else {
      const above = refs.filter(r => r.rank < rank && r.g !== g).slice(-CHART_NEIGHBOURS);
      const below = refs.filter(r => r.rank > rank && r.g !== g).slice(0, CHART_NEIGHBOURS);
      if (above.length >= 3) {
        const ceil = CHART_TOLERANCE * median(above.map(r => baseUnits.get(r.g)!));
        if (g.unitsMid > ceil) { target = ceil; bound = "ceiling"; nb = above.length; }
      }
      if (target == null && below.length >= 3) {
        const floor = Math.min(median(below.map(r => baseUnits.get(r.g)!)) / CHART_TOLERANCE, CHART_MAX_RAISE * g.unitsMid);
        if (g.unitsMid < floor) { target = floor; bound = "floor"; nb = below.length; }
      }
    }
    if (target == null) continue;
    const before = g.unitsMid; const after = Math.round(target); const f = after / before;
    if (inLaunchWindow(g.releaseDate, today)) {
      // Shown so the contradiction is visible, but never applied: the chart is incomplete for pre-order / launch-week titles.
      g.chartConsistency = { chartRank: rank, before, after, bound: "launch_window_protected", applied: false, neighbours: nb } as ChartNote;
      protectedLaunch++;
      continue;
    }
    const note: ChartNote = { chartRank: rank, before, after, bound, applied: mode === "enforce", neighbours: nb };
    g.chartConsistency = note;
    if (bound === "off_chart_cap") capped++; else moved++;
    if (mode === "enforce") {
      g.unitsMid = after;
      if (g.revenueMidUsd != null) g.revenueMidUsd = g.revenueMidUsd * f;
      if (g.ownersMid != null) g.ownersMid = Math.round(g.ownersMid * f);
      g.estimateMethod = `${g.estimateMethod ?? g.dataSource ?? "est"}+chart_consistency_v1`;
    }
  }
  return { moved, capped, protectedLaunch, skipped: null };
}
