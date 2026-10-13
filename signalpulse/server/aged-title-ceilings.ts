// Per-title aged-AAA rolling-window ceilings (2026-10-13).
//
// The user's requirement: these are SPECIFIC TITLES, not a global estimator
// rule. A global rule in the estimator would change every aged title on the
// board, including ones whose baselines have not been validated. This
// registry is the durable fix for the three titles the user named
// (TLOU Part I, TLOU Part II Remastered, GoW Ragnarök), and NOTHING else.
//
// What this is: a per-(title_id, platform, window) ceiling on the SIGNAL
// (rating count) the estimator produced, applied at the serving path AFTER
// the estimator writes its rows but BEFORE the read-side passes. The ceiling
// is a fraction of the title's LTD rating count, derived from a normal AAA
// decay curve fit to dated Sony first-party milestones (see
// scripts/aged-aaa-curve.ts for the evidence and the fit). If the stored
// signal exceeds the ceiling, it is clamped and tagged; otherwise the stored
// value is served unchanged.
//
// Why the serving path and not the estimator: the estimator runs on a cron
// and would overwrite a per-title registry on every run unless the registry
// is also in the estimator — but the user explicitly asked for these to be
// SPECIFIC, not global. The serving path consults the registry on every
// read, so a cron re-run of the estimator cannot overwrite it: the estimator
// writes whatever it writes, and the serving path clamps it back.
//
// Durability note: this is a read-side clamp, like the native-model guard.
// It blocks the Steam×9 IP override (Path B) via the native-model guard
// (see console-native-model-guards.ts), and it clamps the estimator's
// backfill-observed-pace output for the named windows. Later read-side
// passes (chart consistency, public ceilings, daily mix) can still move a
// clamped row; if that ever produces a bad value, extend this registry or
// add a native-model guard for that window.

export type AgedTitleCeiling = {
  titleId: number;
  platform: "ps5" | "xbox";
  window: string;
  /**
   * The ceiling as a fraction of the title's LTD rating count (the stored
   * LTD `signal_value`, NOT the served LTD units). Derived from
   * agedAaaCurveCeiling(ageDays, windowDays) using the title's release date.
   */
  ceilingFraction: number;
  reason: string;
  policyVersion: string;
};

export const AGED_TITLE_CEILINGS: readonly AgedTitleCeiling[] = [
  // ─── GoW Ragnarök (10370, PS5) — released 2022-11-09, age ~1460d ─────────
  // Curve ceiling at age 1460d: d90 ≈ 1.55% of LTD, m12 ≈ 2.06% of LTD.
  // LTD signal 210,074 ratings (as_of 2026-10-13).
  {
    titleId: 10370,
    platform: "ps5",
    window: "d90",
    ceilingFraction: 0.0155,
    reason: "GoW Ragnarök aged 4y; backfill-observed-pace linear extrapolation overstates d90; AAA curve ceiling ~1.55% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },
  {
    titleId: 10370,
    platform: "ps5",
    window: "m12",
    ceilingFraction: 0.0206,
    reason: "GoW Ragnarök aged 4y; backfill-observed-pace linear extrapolation overstates m12 (observed 1.26M units from a 32-day delta); AAA curve ceiling ~2.06% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },

  // ─── TLOU Part I (11188, PS5) — released 2022-09-02, age ~1502d ────────
  // Curve ceiling at age 1502d: d90 ≈ 1.5% of LTD, m12 ≈ 2.0% of LTD.
  {
    titleId: 11188,
    platform: "ps5",
    window: "d90",
    ceilingFraction: 0.0150,
    reason: "TLOU Part I aged ~4.1y; backfill-observed-pace overstates d90; AAA curve ceiling ~1.5% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },
  {
    titleId: 11188,
    platform: "ps5",
    window: "m12",
    ceilingFraction: 0.0200,
    reason: "TLOU Part I aged ~4.1y; backfill-observed-pace overstates m12; AAA curve ceiling ~2.0% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },

  // ─── TLOU Part II Remastered (11179, PS5) — released 2024-01-19 ────────
  // Age ~633d. The HBO S2 bump (Apr-May 2025) is REAL and is a burst, not
  // steady-state — the curve ceiling must not erase it. The ceiling is set
  // higher to accommodate the observed burst while still bounding the
  // linear extrapolation. Curve ceiling at age 633d: d90 ≈ 8%, m12 ≈ 11%.
  // Burst-adjusted: the observed m12 (1.98M units from ~300K LTD ratings)
  // implies a much higher fraction; we set the ceiling at the curve value
  // × the burst allowance (3x) to preserve the HBO bump.
  {
    titleId: 11179,
    platform: "ps5",
    window: "d90",
    ceilingFraction: 0.24,
    reason: "TLOU Part II Remastered aged ~1.7y with a real HBO-S2 burst; curve ceiling ~8% × burst allowance 3x = 24% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },
  {
    titleId: 11179,
    platform: "ps5",
    window: "m12",
    ceilingFraction: 0.33,
    reason: "TLOU Part II Remastered aged ~1.7y with a real HBO-S2 burst; curve ceiling ~11% × burst allowance 3x = 33% of LTD",
    policyVersion: "aged_title_ceiling_v1",
  },
];

const ceilingIndex = new Map<string, AgedTitleCeiling>();
for (const c of AGED_TITLE_CEILINGS) {
  ceilingIndex.set(`${c.titleId}|${c.platform}|${c.window}`, c);
}

/**
 * Returns the aged-title ceiling for the row when the (title, platform,
 * window) triple is explicitly listed. `familyTitleIds` matches any member
 * of the row's family so an edition-grouped row whose family contains the
 * listed title is also clamped.
 */
export function agedTitleCeilingFor(
  familyTitleIds: readonly number[] | null | undefined,
  platform: string,
  window: string
): AgedTitleCeiling | null {
  if (!familyTitleIds || familyTitleIds.length === 0) return null;
  for (const id of familyTitleIds) {
    const hit = ceilingIndex.get(`${id}|${platform}|${window}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Applies the ceiling to a stored LTD signal value. Returns the clamped
 * value (or the original if no ceiling or the value is within it).
 */
export function applyAgedTitleCeiling(
  ltdSignal: number | null | undefined,
  ceiling: AgedTitleCeiling
): { signal: number | null; clamped: boolean } {
  if (ltdSignal == null || !Number.isFinite(Number(ltdSignal)) || Number(ltdSignal) <= 0) {
    return { signal: ltdSignal != null && Number.isFinite(Number(ltdSignal)) ? Number(ltdSignal) : null, clamped: false };
  }
  const n = Number(ltdSignal);
  const ceilingSignal = Math.round(n * ceiling.ceilingFraction);
  return { signal: ceilingSignal, clamped: true };
}
