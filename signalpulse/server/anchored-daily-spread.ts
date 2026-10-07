/**
 * Daily series for a title with a verified lifetime anchor: every day is the platform's daily shape scaled by one
 * factor k, so the days add up to lifetime exactly and lifetime keeps growing with the shape after the anchor date.
 *
 *   whole-life title (released inside the series): k = anchor / sum of shape up to the anchor date,
 *     so the days up to the anchor date add up to the anchor exactly, and lifetime = sum of ALL days.
 *   older title: k = anchor / estimator lifetime at the anchor date; the part of lifetime that predates the series is
 *     reported as `beforeSeriesUsd`, never placed on a day.
 *
 * Shape: the platform's own daily values when they are credible (most days valued, no single day dominating);
 * otherwise Steam's daily shape (same title, same days). Missing or zero days inside the shape are interpolated
 * from their neighbours and marked. Read-side only.
 */
export type Plat = "steam" | "ps5" | "xbox";
export type SpreadInput = {
  anchorUsd: number; anchorAsOf: string; wholeLife: boolean; estimatorAtAnchorUsd: number | null;
};
export type Reconciliation = {
  anchorUsd: number; anchorAsOf: string; k: number; shape: "own" | "steam" | "own_not_credible";
  wholeLife: boolean; daysSumUsd: number; growthUsd: number; lifetimeUsd: number; beforeSeriesUsd: number;
  interpolatedDays: number;
};

const MIN_CREDIBLE_DAYS = 4, MIN_VALUED_FRACTION = 0.8, MAX_DAY_SHARE = 0.35;

export function shapeCredible(vals: Array<number | null>): boolean {
  const first = vals.findIndex(v => v != null && v > 0);
  if (first < 0) return false;
  const span = vals.slice(first);
  if (span.length < MIN_CREDIBLE_DAYS) return false;
  const pos = span.filter(v => v != null && v > 0) as number[];
  if (pos.length / span.length < MIN_VALUED_FRACTION) return false;
  const total = pos.reduce((a, b) => a + b, 0);
  return span.length < 5 || Math.max(...pos) / total <= MAX_DAY_SHARE;
}

/** Fill null/zero days that sit between two valued days by linear interpolation. Returns the filled indexes. */
export function interpolateShape(vals: Array<number | null>): { shape: Array<number | null>; filled: Set<number> } {
  const out = vals.map(v => (v != null && v > 0 ? v : null));
  const filled = new Set<number>();
  const valued = out.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0);
  for (let a = 0; a + 1 < valued.length; a++) {
    const i0 = valued[a], i1 = valued[a + 1];
    for (let i = i0 + 1; i < i1; i++) {
      out[i] = (out[i0] as number) + ((out[i1] as number) - (out[i0] as number)) * (i - i0) / (i1 - i0);
      filled.add(i);
    }
  }
  return { shape: out, filled };
}

export function spreadToAnchors(
  points: Array<Record<string, any>>, inputs: Partial<Record<Plat, SpreadInput>>,
): Partial<Record<Plat, Reconciliation>> {
  const dates = points.map(p => p.date as string);
  const raw = (pl: Plat) => points.map(p => (typeof p[pl] === "number" ? (p[pl] as number) : null));
  const result: Partial<Record<Plat, Reconciliation>> = {};
  for (const pl of ["steam", "ps5", "xbox"] as Plat[]) {
    const inp = inputs[pl];
    if (!inp || !(inp.anchorUsd > 0)) continue;
    const own = raw(pl);
    let shapeKind: Reconciliation["shape"] = "own";
    let source = own;
    if (!shapeCredible(own)) {
      const steam = raw("steam");
      if (inp.wholeLife && pl !== "steam" && shapeCredible(steam)) { source = steam; shapeKind = "steam"; }
      else shapeKind = "own_not_credible";
    }
    const { shape, filled } = interpolateShape(source);
    const upTo = shape.reduce<number>((a, v, i) => (v != null && dates[i] <= inp.anchorAsOf ? a + v : a), 0);
    let k: number;
    if (inp.wholeLife) { if (!(upTo > 0)) continue; k = inp.anchorUsd / upTo; }
    else { if (!(inp.estimatorAtAnchorUsd && inp.estimatorAtAnchorUsd > 0) || shapeKind === "steam") continue; k = inp.anchorUsd / inp.estimatorAtAnchorUsd; }
    let days = 0, post = 0, interpolated = 0;
    points.forEach((p, i) => {
      const v = shape[i];
      if (v == null) { p[pl] = null; return; }
      p[pl] = v * k; days += v * k;
      if (dates[i] > inp.anchorAsOf) post += v * k;
      const al = (p.allocation ??= {}) as Record<string, string>;
      if (shapeKind === "steam") al[pl] = "anchor_spread:steam_shape";
      else if (filled.has(i)) { al[pl] = "anchor_spread:interpolated"; }
      if (filled.has(i)) interpolated++;
    });
    const lifetime = inp.wholeLife ? days : inp.anchorUsd + post;
    result[pl] = { anchorUsd: inp.anchorUsd, anchorAsOf: inp.anchorAsOf, k, shape: shapeKind, wholeLife: inp.wholeLife,
      daysSumUsd: days, growthUsd: lifetime - inp.anchorUsd, lifetimeUsd: lifetime, beforeSeriesUsd: lifetime - days,
      interpolatedDays: interpolated };
  }
  for (const p of points) {
    if (p.allocation && !Object.keys(p.allocation).length) delete p.allocation;
    const parts = ["steam", "ps5", "xbox"].map(pl => p[pl]).filter((v: any) => typeof v === "number") as number[];
    p.combined = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  return result;
}
