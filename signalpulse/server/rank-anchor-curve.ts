// Durable floor for fresh top-ranked console releases (replaces the fragile mean-of-neighbours floor).
//
// Legacy (estimate-console-units.ts step 8a): mean of the d7 units of up to 6 stabilised neighbours on the storefront
// chart, tapered by rank^-0.7. Weak points seen on Gears of War: E-Day (2026-10-04): few peers (3 usable), one outlier 28x the
// others moves the mean, a strict noise gate leaves only high-signal neighbours (survivor bias), and a modeled override
// counts as a peer. Any change in who has a d7 estimate near the title therefore moves its number.
//
// This module computes the alternatives (pure, no database):
//   - curve:  units at the title's rank on the log-log curve fitted that day on every eligible reference title
//             (trimmed once, at least 20 points, slope -0.2 to -2.5), the same fit the chart-consistency pass uses.
//   - median: median of per-peer rank-scaled units over eligible peers, needing at least 3.
// Mode (env RANK_ANCHOR_MODE): "legacy" (default, behaviour unchanged) | "report" (legacy applied, comparison logged) |
// "curve" (the durable floor applied). Eligible references exclude fresh releases, per-title overrides, other rank-anchored rows
// and gated rows.

import { fitRankCurve, curveUnits, type DeepCurve } from "./console-chart-consistency";

export type RankAnchorMode = "legacy" | "report" | "curve";
export function rankAnchorModeFromEnv(v: string | undefined): RankAnchorMode {
  const m = (v ?? "legacy").toLowerCase();
  return m === "report" || m === "curve" ? m : "legacy";
}

export const RANK_ANCHOR_MIN_PEERS = 3;
export interface Ref { rank: number; units: number }

/** The existing formula, unchanged: mean(units) * anchorWeight / mean(rank weights). */
export function legacyFloor(peers: Ref[], anchorRank: number, alpha: number): number | null {
  if (peers.length === 0) return null;
  const unitMean = peers.reduce((s, p) => s + p.units, 0) / peers.length;
  const weightMean = peers.reduce((s, p) => s + Math.pow(p.rank, -alpha), 0) / peers.length;
  return unitMean * (Math.pow(anchorRank, -alpha) / weightMean);
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** Median of each peer's units scaled to the anchor's rank. Robust to one outlier; null with fewer than 3 peers. */
export function medianPeerFloor(peers: Ref[], anchorRank: number, alpha: number): number | null {
  if (peers.length < RANK_ANCHOR_MIN_PEERS) return null;
  return median(peers.map(p => p.units * Math.pow(anchorRank / p.rank, -alpha)));
}

export function curveFloor(refs: Ref[], anchorRank: number): { floor: number; curve: DeepCurve } | null {
  const curve = fitRankCurve(refs);
  if (!curve) return null;
  return { floor: curveUnits(curve, anchorRank), curve };
}

export interface FloorChoice {
  floor: number | null;
  basis: "curve" | "median_peers" | null;
  curve: DeepCurve | null;
  medianFloor: number | null;
}

/** The durable floor: the daily rank curve when it can be fitted, else the robust peer median, else none. */
export function chooseFloor(refs: Ref[], eligiblePeers: Ref[], anchorRank: number, alpha: number): FloorChoice {
  const c = curveFloor(refs, anchorRank);
  const med = medianPeerFloor(eligiblePeers, anchorRank, alpha);
  if (c) return { floor: c.floor, basis: "curve", curve: c.curve, medianFloor: med };
  if (med != null) return { floor: med, basis: "median_peers", curve: null, medianFloor: med };
  return { floor: null, basis: null, curve: null, medianFloor: null };
}
