/** A cumulative count recovering after a correction is not another sale. */
export function advanceLifetimeSignal(current: number | null, previous: number | null) {
  const valid = (v: number | null): v is number => v != null && Number.isFinite(v) && v >= 0;
  if (!valid(current)) return { delta: 0, highWater: valid(previous) ? previous : null };
  if (!valid(previous)) return { delta: 0, highWater: current };
  return { delta: Math.max(0, current - previous), highWater: Math.max(current, previous) };
}
