// Read-side native-model guards (2026-10-11).
//
// Path B in routes-console-leaderboards.ts derives a console row's windowed
// revenue from its Steam family sibling (revenue = steam × factor) and then
// back-solves units from that derived revenue. The Sony first-party IP rule
// ("The Last of Us" → PS5 90 / Steam 10, factor 9.0) is a franchise platform-
// mix heuristic; it is not a per-title sales estimate. When it fires on an
// aged row it silently replaces the native estimator's own PS5 output with a
// number whose only support is that mix ratio and an MSRP × ASP-factor —
// observed effects on the two rows below were a ~4.7x inflation (Part I d30)
// and a replaced value that a later chart pass moved further down (Part II).
//
// These guards keep the native estimator's revenue AND units for the listed
// (title_id, platform) pairs on the explicitly scoped windows. The Path B
// Steam-anchored derivation (and the derived_from_steam_ip_override /
// derived_from_steam dataSource tag) is skipped for these rows; the
// SQL-computed estimator value flows to the remaining read-side passes.
// Verified anchors still win above this point. The estimator ladder and
// every other title (including other Sony first-party IPs) are untouched.
//
// Window scope is explicit and intentionally narrow: only the windows whose
// served values were inspected during the investigation (d7, d30). Extend a
// row's scope only after its wider-window baseline is validated the same way.
// Later read-side passes (chart consistency, public ceilings, daily mix) are
// NOT blocked — a guarded row can still be moved by them, so the final
// served value is not guaranteed to equal the raw estimator value.

export type ConsoleNativeModelGuard = {
  titleId: number;
  platform: "ps5" | "xbox";
  windows: readonly string[];
  reason: string;
  policyVersion: string;
};

const guardsRegistry: ConsoleNativeModelGuard[] = [
  {
    // The Last of Us Part I (PS5). Native estimator d30 (backfill-observed-pace
    // on the PS5 rating-pool delta) was ~130K units / ~$7.3M; the Steam × 9.0
    // IP override replaced it with 609,449 units / $34.1M on the served board
    // (verified 2026-10-11, d30). Keep the native estimate.
    titleId: 11188,
    platform: "ps5",
    windows: ["d7", "d30"],
    reason: "aged first-party PS5 row; Steam×9 IP override inflated served d30 from native ~130K units to 609K units",
    policyVersion: "native_model_guard_v1",
  },
  {
    // The Last of Us Part II Remastered (PS5). Native estimator d30 was ~163K
    // units / ~$6.5M; the Steam × 9.0 IP override replaced it and a chart
    // pass moved the served row to 57,353 units / $2.3M (verified 2026-10-11,
    // d30). Same franchise-mix concern as Part I. Keep the native estimate.
    titleId: 11179,
    platform: "ps5",
    windows: ["d7", "d30"],
    reason: "aged first-party PS5 remaster; Steam×9 IP override replaced native ~163K d30 units with 57K units",
    policyVersion: "native_model_guard_v1",
  },
];

export const CONSOLE_NATIVE_MODEL_GUARDS: readonly ConsoleNativeModelGuard[] = guardsRegistry;

const guardIndex = new Map<string, ConsoleNativeModelGuard>();
for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
  for (const w of g.windows) guardIndex.set(`${g.titleId}|${g.platform}|${w}`, g);
}

/**
 * Rebuilds the guard index from the current CONSOLE_NATIVE_MODEL_GUARDS array.
 * Used by route-level tests to drive a widened window scope in-process without
 * editing the production registry. Production code never mutates the registry.
 */
export function rebuildGuardIndex(): void {
  guardIndex.clear();
  for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
    for (const w of g.windows) guardIndex.set(`${g.titleId}|${g.platform}|${w}`, g);
  }
}

/**
 * Test-only hook: replace the guard registry with a widened-scope copy and
 * rebuild the index. Returns a restore function that must be called in a
 * finally block. Production code never calls this.
 */
export function widenGuardScopeForTest(windows: readonly string[]): () => void {
  const original = guardsRegistry.slice();
  guardsRegistry.length = 0;
  guardsRegistry.push(...original.map((g) => ({ ...g, windows })));
  rebuildGuardIndex();
  return () => {
    guardsRegistry.length = 0;
    guardsRegistry.push(...original);
    rebuildGuardIndex();
  };
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
