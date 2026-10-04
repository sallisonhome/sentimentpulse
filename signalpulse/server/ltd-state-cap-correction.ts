// One-title correction of a stale title_ltd_state high-water mark left by an uncapped rank-anchor floor.
// LTD is max(windows, persisted state), so after the cap (PR 201) the state alone keeps the old value.
// The corrected value is the largest NON-ltd window of the same as-of day, which is exactly what the
// accumulator would produce with the stale state cleared. It only ever lowers, never raises, and only
// when the d7 row carries the ratings cap tag.
export type WindowRow = { window: string; units_mid: number | null; method: string | null; gated_reason: string | null };

export function correctedLtdUnits(rows: WindowRow[], storedLtd: number): { target: number | null; reason: string } {
  const d7 = rows.find(r => r.window === "d7");
  if (!d7 || !d7.method || !/^rank_anchor:.*\+ratings_cap_v1/.test(d7.method)) return { target: null, reason: "d7 row is not ratings-capped" };
  const vals = rows.filter(r => r.window !== "ltd" && !r.gated_reason && r.units_mid != null).map(r => r.units_mid as number);
  if (!vals.length) return { target: null, reason: "no usable window rows" };
  const target = Math.round(Math.max(...vals));
  if (target >= storedLtd) return { target: null, reason: `target ${target} is not below stored ${storedLtd}` };
  return { target, reason: "lower stored LTD to the largest window" };
}
