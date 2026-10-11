// Read-side native-model guards (2026-10-11).
//
// Path B in routes-console-leaderboards.ts derives a console row's windowed
// revenue from its Steam family sibling (revenue = steam × factor) and then
// back-solves units from that derived revenue. The Sony first-party IP rule
// ("The Last of Us" → PS5 90 / Steam 10, factor 9.0) is a platform-mix
// heuristic; it is not a per-title sales estimate. For aged first-party
// titles whose PS5 rating pool is a shared-concept lifetime pool (PSN
// concept ratings are shared across a concept's SKUs, so a PS5 row can
// inherit a pool that includes PS4 and other-edition history), the
// Steam-derived revenue is not a better bound than the native estimator's
// own output — it can replace the estimator value with a number whose only
// support is a franchise-wide platform mix and an MSRP × ASP-factor.
//
// These guards keep the native estimator's revenue AND units for the listed
// (title_id, platform) pairs. The Path B Steam-anchored derivation (and the
// derived_from_steam_ip_override / derived_from_steam dataSource tag) is
// skipped for these rows; the SQL-computed estimator value flows through the
// remaining read-side passes unchanged. Verified anchors, per-title
// overrides and the estimator ladder are untouched — a verified anchor still
// wins over the guard.
//
// Window scope is explicit: guards apply to the supported board windows the
// board serves (d7, d30, d90, m12, ltd). Only the two named rows change;
// every other title (including other Sony first-party IPs) keeps the
// existing Path B behaviour.

export type ConsoleNativeModelGuard = {
  titleId: number;
  platform: "ps5" | "xbox";
  windows: readonly string[];
  reason: string;
  policyVersion: string;
};

export const CONSOLE_NATIVE_MODEL_GUARDS: readonly ConsoleNativeModelGuard[] = [
  {
    // The Last of Us Part I (PS5) — an aged
    // first-party title. The native estimator's own d30 is ~130K units /
    // ~$7.3M (backfill-observed-pace on the PS5 rating-pool delta, which
    // grows only ~100/day against a 145K pool that predates the window).
    // The Steam × 9.0 IP override replaced this with 609,449 d30 units /
    // $34.1M, an ~4.7x inflation whose only basis is a franchise mix
    // heuristic. Keep the native estimate.
    titleId: 11188,
    platform: "ps5",
    windows: ["d7", "d30", "d90", "m12", "ltd"],
    reason: "aged first-party PS5 row; Steam×9 IP override inflated d30 from native ~130K units to 609K units",
    policyVersion: "native_model_guard_v1",
  },
  {
    // The Last of Us Part II Remastered (PS5) — remaster of an older title.
    // Same aged-first-party profile: a PS5 rating pool
    // of ~310K growing ~100/day, consistent with a shared PSN concept pool
    // (the PS5 and PS4 SKUs share the concept). The native estimator's own
    // d30 is ~163K units / ~$6.5M; the IP override reduced the served row
    // to 57K / $2.3M (chart-consistency then moved it further down). A
    // franchise-mix heuristic is not a better bound than the estimator's
    // own output for this row either. Keep the native estimate.
    titleId: 11179,
    platform: "ps5",
    windows: ["d7", "d30", "d90", "m12", "ltd"],
    reason: "aged first-party PS5 remaster; Steam×9 IP override replaced native ~163K d30 units with 57K units",
    policyVersion: "native_model_guard_v1",
  },
];

const guardIndex = new Map<string, ConsoleNativeModelGuard>();
for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
  for (const w of g.windows) guardIndex.set(`${g.titleId}|${g.platform}|${w}`, g);
}

/**
 * Returns the native-model guard for the row when the (title, platform, window)
 * triple is explicitly listed. `familyTitleIds` matches any member of the row's
 * family so an edition-grouped row whose family contains the guarded title is
 * also protected.
 */
export function nativeModelGuardFor(
  familyTitleIds: readonly number[] | null | undefined,
  platform: string,
  window: string
): ConsoleNativeModelGuard | null {
  if (!familyTitleIds || familyTitleIds.length === 0) return null;
  for (const id of familyTitleIds) {
    const hit = guardIndex.get(`${id}|${platform}|${window}`);
    if (hit) return hit;
  }
  return null;
}
