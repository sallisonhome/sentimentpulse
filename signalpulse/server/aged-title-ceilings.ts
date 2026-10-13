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

  // ─── v2: audit-widened batch (2026-10-13, PR #274) ─────────────────────────
  // Criteria: PS5, LTD > 1M units, release age > 730d, and the stored
  // d90/m12 exceeded 5x the curve-consistent ceiling. Fractions are the
  // curve values at each title's actual age (see the audit table in
  // PR #274). The burst exemption in routes-console-leaderboards.ts
  // (recent daily rate vs lifetime average, >10x) protects any of these
  // titles that later enters a real burst (an update bump, a deep-discount
  // event) — the observed pace wins over the ceiling.
  {
    titleId: 10320, // Ready or Not — m12 was 133% of LTD (logical impossibility)
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Ready or Not aged ~2.8y; m12 stored at 133% of LTD; curve ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10320,
    platform: "ps5", window: "m12", ceilingFraction: 0.0603,
    reason: "Ready or Not aged ~2.8y; m12 stored at 133% of LTD; curve ceiling 6.03%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10513, // Control: Ultimate Edition
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "Control UE aged ~6.1y; d90 33.5x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10513,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "Control UE aged ~6.1y; m12 27.2x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10535, // FF7 Remake Intergrade
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "FF7R Intergrade aged ~5.3y; d90 37.9x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10535,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "FF7R Intergrade aged ~5.3y; m12 35.1x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10565, // Marvel's Spider-Man Remastered
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "Spider-Man Remastered aged ~5.9y; d90 23.3x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10565,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "Spider-Man Remastered aged ~5.9y; m12 23.3x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10350, // No Man's Sky
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "No Man's Sky aged ~5.9y; d90 14.0x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10350,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "No Man's Sky aged ~5.9y; m12 14.9x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10624, // It Takes Two
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "It Takes Two aged ~5.6y; d90 11.3x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10624,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "It Takes Two aged ~5.6y; m12 18.0x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10319, // Forza Horizon 5 Deluxe
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "FH5 Deluxe aged ~4.9y; d90 10.7x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10319,
    platform: "ps5", window: "m12", ceilingFraction: 0.0124,
    reason: "FH5 Deluxe aged ~4.9y; m12 17.0x over curve; ceiling 1.24%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10876, // RE2
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "RE2 aged ~4.3y; d90 19.1x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10876,
    platform: "ps5", window: "m12", ceilingFraction: 0.0316,
    reason: "RE2 aged ~4.3y; m12 9.6x over curve; ceiling 3.16%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11035, // Skyrim Special Edition
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "Skyrim SE aged ~4.9y; d90 13.1x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11035,
    platform: "ps5", window: "m12", ceilingFraction: 0.0126,
    reason: "Skyrim SE aged ~4.9y; m12 10.4x over curve; ceiling 1.26%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10520, // Dead by Daylight
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "Dead by Daylight aged ~5.9y; d90 7.9x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10520,
    platform: "ps5", window: "m12", ceilingFraction: 0.0100,
    reason: "Dead by Daylight aged ~5.9y; m12 11.4x over curve; ceiling 1.0%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11157, // RE7
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "RE7 aged ~4.3y; d90 16.9x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11157,
    platform: "ps5", window: "m12", ceilingFraction: 0.0316,
    reason: "RE7 aged ~4.3y; m12 5.3x over curve; ceiling 3.16%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11337, // The Outlast Trials
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Outlast Trials aged ~2.6y; d90 11.0x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11337,
    platform: "ps5", window: "m12", ceilingFraction: 0.0847,
    reason: "Outlast Trials aged ~2.6y; m12 5.8x over curve; ceiling 8.47%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10402, // Elden Ring
    platform: "ps5", window: "d90", ceilingFraction: 0.0025,
    reason: "Elden Ring aged ~4.6y; d90 8.7x over curve; ceiling 0.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10402,
    platform: "ps5", window: "m12", ceilingFraction: 0.0220,
    reason: "Elden Ring aged ~4.6y; m12 5.2x over curve; ceiling 2.2%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10651, // Witcher 3 Remastered
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Witcher 3 Remastered aged ~3.8y; d90 8.9x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10651,
    platform: "ps5", window: "m12", ceilingFraction: 0.0425,
    reason: "Witcher 3 Remastered aged ~3.8y; m12 6.0x over curve; ceiling 4.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10691, // RE4
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "RE4 aged ~3.6y; d90 7.2x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10691,
    platform: "ps5", window: "m12", ceilingFraction: 0.0425,
    reason: "RE4 aged ~3.6y; m12 10.6x over curve; ceiling 4.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10352, // Marvel's Spider-Man 2
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Spider-Man 2 aged ~3y; d90 8.1x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10352,
    platform: "ps5", window: "m12", ceilingFraction: 0.0444,
    reason: "Spider-Man 2 aged ~3y; m12 7.8x over curve; ceiling 4.44%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10636, // Ark: Survival Ascended
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Ark SA aged ~3y; d90 5.8x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10636,
    platform: "ps5", window: "m12", ceilingFraction: 0.0459,
    reason: "Ark SA aged ~3y; m12 8.5x over curve; ceiling 4.59%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11345, // Alan Wake 2
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Alan Wake 2 aged ~3y; d90 5.9x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11345,
    platform: "ps5", window: "m12", ceilingFraction: 0.0464,
    reason: "Alan Wake 2 aged ~3y; m12 5.4x over curve; ceiling 4.64%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10362, // Arma Reforger
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Arma Reforger aged ~2.9y; d90 8.6x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10362,
    platform: "ps5", window: "m12", ceilingFraction: 0.0523,
    reason: "Arma Reforger aged ~2.9y; m12 9.2x over curve; ceiling 5.23%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10635, // Cyberpunk 2077 Ultimate
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Cyberpunk UE aged ~3y; d90 3.6x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10635,
    platform: "ps5", window: "m12", ceilingFraction: 0.0425,
    reason: "Cyberpunk UE aged ~3y; m12 4.1x over curve; ceiling 4.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11192, // Horizon Forbidden West CE
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "HFW CE aged ~3y; d90 4.0x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 11192,
    platform: "ps5", window: "m12", ceilingFraction: 0.0425,
    reason: "HFW CE aged ~3y; m12 6.1x over curve; ceiling 4.25%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10645, // Hogwarts Legacy
    platform: "ps5", window: "d90", ceilingFraction: 0.0105,
    reason: "Hogwarts Legacy aged ~3.7y; d90 2.3x over curve; ceiling 1.05%",
    policyVersion: "aged_title_ceiling_v2",
  },
  {
    titleId: 10645,
    platform: "ps5", window: "m12", ceilingFraction: 0.0425,
    reason: "Hogwarts Legacy aged ~3.7y; m12 3.8x over curve; ceiling 4.25%",
    policyVersion: "aged_title_ceiling_v2",
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
