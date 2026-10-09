// Operator-verified day-one console unit actuals (2026-10-09).
//
// A day-one actual is a floor and a releveling point for exactly one
// (title_id, platform) pair. It does three things and nothing else:
//
//   1. The daily series serves the actual for the anchor day itself.
//   2. LTD is relevelled to actual + later native increments: the estimator's
//      own day-over-day deltas are preserved; the level comes from the actual.
//   3. Every rolling window (d7/d30/d90/m12) that still contains the anchor
//      day carries the gap (actual − native LTD at the anchor day), so boards
//      and window estimates agree with the daily series. Once the anchor day
//      rolls out of a window, that window returns to native scaling. LTD
//      always carries it.
//
// Scope is by construction: only the (title_id, platform) pairs listed below
// are adjusted. Platform-wide multipliers, calibration, and every other
// title's estimates are untouched. The anchor day's value is never displaced
// by a later revised native estimate: the native LTD at the anchor day is
// frozen in `baselineLtdUnits` when the anchor is recorded.
//
// Rows the estimator already relevelled are tagged with CONSOLE_DAY_ACTUAL_TAG
// in window_estimates_daily.method; readers must keep tagged rows as-is so a
// partially backfilled history is never double-lifted.

export type ConsoleDayUnitActual = {
  titleId: number;
  platform: "ps5" | "xbox";
  /** Calendar day the actual covers (the release day). */
  date: string;
  /** Family-total units that day, all SKUs of this platform. */
  units: number;
  /** SKU mix on the anchor day, for revenue attribution (base vs edition). */
  standardShare: number;
  deluxeShare: number;
  /** The estimator's native LTD at `date`, frozen when the anchor was recorded. */
  baselineLtdUnits: number;
  source: string;
};

/** Appended to window_estimates_daily.method on every row this anchor relevels. */
export const CONSOLE_DAY_ACTUAL_TAG = "d1_actual_anchor_v1";

export const CONSOLE_DAY_UNIT_ACTUALS: readonly ConsoleDayUnitActual[] = [
  {
    // Clive Barker's Hellraiser: Revival — PS5 day-one actual reported by the
    // operator on 2026-10-09. SKU mix that day: 55% Deluxe ($49.99) /
    // 45% Standard ($39.99). The base title (11296) carries the concept's
    // shared rating pool, so the family total is anchored on its row; the
    // Deluxe edition row (10990) stays gated by the base-only signal gate and
    // never adds on top. Native LTD at the anchor day was 16,042 units
    // (508 ratings × the platform coefficient).
    titleId: 11296,
    platform: "ps5",
    date: "2026-10-08",
    units: 49200,
    standardShare: 0.45,
    deluxeShare: 0.55,
    baselineLtdUnits: 16042,
    source: "operator-reported PS5 day-one units (2026-10-09)",
  },
];

export function consoleDayActualFor(titleId: number, platform: string): ConsoleDayUnitActual | undefined {
  return CONSOLE_DAY_UNIT_ACTUALS.find((a) => a.titleId === titleId && a.platform === platform);
}

/** Anchored LTD for a native LTD value. Tagged (already-anchored) rows pass through. */
export function anchoredLtdUnits(actual: ConsoleDayUnitActual, ltdUnits: number, alreadyAnchored: boolean): number {
  if (alreadyAnchored) return ltdUnits;
  return actual.units + Math.max(0, ltdUnits - actual.baselineLtdUnits);
}

const WINDOW_DAYS: Record<string, number | null> = { d7: 7, d30: 30, d90: 90, m12: 365, ltd: null };
const DAY_MS = 86400000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** True when `day` falls inside the window of `window` ending at `asOf`. */
export function windowContainsDay(window: string, asOf: string, day: string): boolean {
  const n = WINDOW_DAYS[window];
  if (n == null) return day <= asOf; // ltd: everything up to asOf
  const start = iso(Date.parse(asOf + "T00:00:00Z") - (n - 1) * DAY_MS);
  return day >= start && day <= asOf;
}

export type ActualLtdRow = { date: string; units: number | null; method?: string | null };

/**
 * Relevel a native LTD series onto a day-one actual.
 * The anchor day's row becomes exactly the actual; later rows become
 * actual + native increments; rows before the anchor day are untouched.
 * Rows already tagged with CONSOLE_DAY_ACTUAL_TAG (the estimator relevelled
 * them) pass through unchanged so a mixed history is never double-lifted.
 */
export function relevelConsoleLtd(ltd: ActualLtdRow[], actual: ConsoleDayUnitActual): ActualLtdRow[] {
  return ltd.map((r) => {
    if (r.units == null || r.date < actual.date) return r;
    const already = typeof r.method === "string" && r.method.includes(CONSOLE_DAY_ACTUAL_TAG);
    if (r.date === actual.date) {
      // The actual wins on its own day, even if a revised native estimate is higher.
      return already && r.units === actual.units ? r : { ...r, units: actual.units };
    }
    return { ...r, units: Math.round(anchoredLtdUnits(actual, r.units, already)) };
  });
}
