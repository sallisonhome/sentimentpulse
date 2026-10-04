// Guards for the d7 storefront rank-anchor floor (scripts/estimate-console-units.ts, step 8a).
//
// The floor lifts a freshly launched console title to a peer-based value because day-one ratings are
// thin. Two failure modes it had:
//  1. No ceiling. A $24.99 indie ranked on the Xbox top-paid chart (which counts Play Anywhere and
//     PC purchases) was floored from mature full-price neighbours to 311,931 units while its own
//     ratings implied ~50K. The floor is now capped at a multiple of the title's own ratings-derived
//     lifetime units, but only once it has enough ratings for that signal to mean something.
//  2. Window inversion. d30 (50,143) stayed below d7 (311,931). A window that contains another
//     cannot be smaller; later windows are raised to the d7 value when d7 carries the floor.
// Nothing here touches an override-anchored title, a gated row or any row without the floor tag.

export const RANK_ANCHOR_CAP_MULT = 3;
export const RANK_ANCHOR_MIN_RATINGS = 200;

type LtdLike = { unitsMid: number | null; signalValue: number | null; gatedReason?: string | null } | undefined;

export function capRankAnchorFloor(floor: number, ltd: LtdLike): { floor: number; capped: boolean; cap: number | null } {
  if (!ltd || ltd.gatedReason) return { floor, capped: false, cap: null };
  if (!(ltd.unitsMid != null && ltd.unitsMid > 0)) return { floor, capped: false, cap: null };
  if (!((ltd.signalValue ?? 0) >= RANK_ANCHOR_MIN_RATINGS)) return { floor, capped: false, cap: null };
  const cap = RANK_ANCHOR_CAP_MULT * ltd.unitsMid;
  return floor > cap ? { floor: cap, capped: true, cap } : { floor, capped: false, cap };
}

type WinRow = {
  window: string; unitsMid: number | null; ownersLow: number | null; ownersMid: number | null;
  ownersHigh: number | null; method: string; gatedReason: string | null;
};
const ORDER = ["d30", "d90", "m12"];

/** rows are one (title, platform). Returns how many rows were raised. */
export function enforceRankAnchorWindows(rows: WinRow[], hasOverride: boolean): number {
  if (hasOverride) return 0;
  const d7 = rows.find(r => r.window === "d7");
  if (!d7 || d7.unitsMid == null || !d7.method.startsWith("rank_anchor:")) return 0;
  let raised = 0;
  for (const w of ORDER) {
    const r = rows.find(x => x.window === w);
    if (!r || r.gatedReason || r.unitsMid == null || r.unitsMid >= d7.unitsMid) continue;
    const ratio = r.unitsMid > 0 ? d7.unitsMid / r.unitsMid : null;
    r.unitsMid = d7.unitsMid;
    if (ratio != null && r.ownersMid != null) {
      r.ownersMid = Math.round(r.ownersMid * ratio);
      r.ownersLow = r.ownersLow != null ? Math.round(r.ownersLow * ratio) : d7.ownersLow;
      r.ownersHigh = r.ownersHigh != null ? Math.round(r.ownersHigh * ratio) : d7.ownersHigh;
    } else { r.ownersMid = d7.ownersMid; r.ownersLow = d7.ownersLow; r.ownersHigh = d7.ownersHigh; }
    r.method = `${r.method}+window_floor_rank_anchor_v1`;
    raised++;
  }
  return raised;
}
