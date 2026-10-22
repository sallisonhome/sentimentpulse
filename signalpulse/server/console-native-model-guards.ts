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

  // ─── v2: audit-widened batch (2026-10-13, PR #275) ───────────────────────
  // These 22 aged PS5 titles (LTD > 1M, age > 730d, curve overstatement > 5x)
  // carry an aged-title-ceiling_v2 registry row that clamps the NATIVE
  // estimator value. But the Steam×9 IP override replaces the native value
  // BEFORE the ceiling clamp runs, so the clamp fires on the wrong number
  // (observed post-deploy 2026-10-13: 17 of 22 titles still over the
  // ceiling, agedTitleCeiling metadata set but units unclamped). Blocking the
  // override on d90/m12 lets the native value reach the clamp. LTD and
  // d7/d30 are deliberately NOT guarded — the ceiling registry does not
  // cover them and the user scoped the fix to d90/m12.
  {
    titleId: 10319, // Forza Horizon 5 Deluxe
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; Steam×9 IP override replaces the native value before the aged-title ceiling can clamp it",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10320, // Ready or Not
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; m12 stored at 133% of LTD; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10350, // No Man's Sky
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 14.0x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10352, // Marvel's Spider-Man 2
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 8.1x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10362, // Arma Reforger
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 8.6x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10402, // Elden Ring
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 8.7x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10513, // Control: Ultimate Edition
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 33.5x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10520, // Dead by Daylight
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 7.9x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10535, // FF7 Remake Intergrade
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 37.9x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10565, // Marvel's Spider-Man Remastered
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 23.3x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10624, // It Takes Two
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 11.3x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10635, // Cyberpunk 2077 Ultimate Edition
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 3.6x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10636, // Ark: Survival Ascended
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 5.8x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10645, // Hogwarts Legacy
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 2.3x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10651, // Witcher 3 Remastered
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 8.9x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10691, // Resident Evil 4
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 7.2x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 10876, // Resident Evil 2
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 19.1x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 11035, // Skyrim Special Edition
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 13.1x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 11157, // Resident Evil 7
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 16.9x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 11192, // Horizon Forbidden West CE
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 4.0x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 11337, // The Outlast Trials
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 11.0x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },
  {
    titleId: 11345, // Alan Wake 2
    platform: "ps5", windows: ["d90", "m12"],
    reason: "audit-v2 aged PS5 row; d90 5.9x over curve; Steam×9 IP override blocks the ceiling clamp",
    policyVersion: "native_model_guard_v2",
  },

  // ─── v3: RDR2 PS4-backcompat row (2026-10-20) ─────────────────────────
  // RDR2 has no native PS5 SKU; the user approved extracting PS5 estimates
  // from the backcompat SKU's PSN concept-level ratings (title_id 11561,
  // UP1004-CUSA03041_00-REDEMPTIONFULL02, seeded sku_role='base'). The guard
  // blocks the general-ratio Steam derivation (Path B) for ALL windowed rows
  // (d7/d30/d90/m12) so the ratings-driven native value survives — the user's
  // explicit directive. LTD stays unguarded per doctrine (the durable LTD fix
  // is anchor work, not a read-side guard). The aged-title ceiling registry
  // (aged_title_ceiling_v4) clamps d90/m12 — the guard and ceiling are a pair.
  {
    titleId: 11561, // Red Dead Redemption 2 (PS4 backcompat on PS5)
    platform: "ps5", windows: ["d7", "d30", "d90", "m12"],
    reason: "RDR2 PS4-backcompat PS5 row (title_id 11561); user direction 2026-10-20: PS5 estimates come from the backcompat SKU's PSN ratings, so Path B's general-ratio Steam derivation is blocked for all windowed rows and the ratings-driven native value survives; aged-title ceiling v4 clamps d90/m12",
    policyVersion: "native_model_guard_v3",
  },

  // ─── v4: Hellraiser operator anchor contract (2026-10-22) ───────────────
  // The operator re-anchored Hellraiser PS5 (145,300 LTD units through
  // 2026-10-21) and set explicit ASPs ($40 Steam / $33.05 console). The deck
  // contract module (hellraiser-deck-contract.ts) is the final authority for
  // the served values; this guard keeps Path B's general-ratio derivation
  // away from 11296/ps5 in the first place so the contract never fights a
  // Steam-ratio overwrite. LTD IS guarded here — unlike the aged-title
  // doctrine — because the operator anchor, not the Steam ratio, is the
  // authority for this title's LTD.
  {
    titleId: 11296, // Clive Barker's Hellraiser: Revival (PS5)
    platform: "ps5", windows: ["d7", "d30", "d90", "m12", "ltd"],
    reason: "Hellraiser PS5 (title_id 11296): operator deck-contract 2026-10-22 anchors PS5 LTD to 145,300 units through 2026-10-21 with operator ASPs; Path B's Steam-ratio derivation is blocked because the operator anchor is the authority (see hellraiser-deck-contract.ts)",
    policyVersion: "native_model_guard_v4",
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
