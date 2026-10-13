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
// Window scope: 2026-10-11 shipped d7/d30 only. 2026-10-13: TLOU rows
// widened to d7/d30/d90/m12; God of War Ragnarök (10370) added scoped to
// d90/m12 — the user's request named those windows. LTD is deliberately NOT
// guarded for any of these rows: the durable LTD fix is the public-anchor +
// AAA-curve work (set LTD from researched public lifetime sales, curve-derive
// the windows, blend observed ratings pace), not a read-side guard. Extend a
// row's window scope only after that window's baseline is validated the
// same way. Note the guard blocks the Path B Steam-anchored overlay only;
// later read-side passes (chart consistency, public ceilings, daily mix) can
// still move a guarded row's value.
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
    windows: ["d7", "d30", "d90", "m12"],
    reason: "aged first-party PS5 row; Steam×9 IP override inflated served d30 from native ~130K units to 609K units; 2026-10-13 served d90 was 1.08M units/$60.7M and m12 5.4M/$302M from the same override",
    policyVersion: "native_model_guard_v1",
  },
  {
    // The Last of Us Part II Remastered (PS5). Native estimator d30 was ~163K
    // units / ~$6.5M; the Steam × 9.0 IP override replaced it and a chart
    // pass moved the served row to 57,353 units / $2.3M (verified 2026-10-11,
    // d30). Same franchise-mix concern as Part I. Keep the native estimate.
    titleId: 11179,
    platform: "ps5",
    windows: ["d7", "d30", "d90", "m12"],
    reason: "aged first-party PS5 remaster; Steam×9 IP override replaced native ~163K d30 units with 57K units; same override still inflating served d90/m12 in 2026-10-13",
    policyVersion: "native_model_guard_v1",
  },
  {
    // God of War Ragnarök (PS5), released 2022-11-09. Aged first-party row with
    // the same Steam×9 IP override firing on every window. Verified 2026-10-13:
    // the override inflated d90 (311K → 468K) and m12 (1.26M → 3.62M). The
    // 2026-10-13 user request scoped the fix to d90/m12; d7/d30/LTD keep the
    // IP override pending the public-anchor + AAA-curve work that will set LTD
    // from researched lifetime sales. Native estimator rows (as_of 2026-10-13,
    // backfill-observed-pace — note these are 32-day linear extrapolations):
    // d7 20,874 / d30 104,621 / d90 311,305 / m12 1,262,495 / LTD 6,633,915.
    titleId: 10370,
    platform: "ps5",
    windows: ["d90", "m12"],
    reason: "aged first-party PS5 row; Steam×9 IP override inflated d90/m12 against the native estimator; native values kept for these windows only",
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
