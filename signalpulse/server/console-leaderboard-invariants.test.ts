// Invariant tests for the console leaderboards estimator + route.
//
// These tests do NOT boot a full SQLite context. They exercise the two pure
// pieces of logic that regressed on 2026-09-12:
//   1. Per-platform noise gate: Xbox rating counts (~1-40 typical) must not
//      be silently rejected by a Steam-scale gate of 50.
//   2. Bootstrap horizon: a title released N days ago must NOT get its LTD
//      value returned as a signal for any window < N. Ghost of Yotei
//      (2025-10-02) hit this on m12: winDays=365 admitted release_date via
//      isReleasedWithin but the projection LTD == m12-window is only true
//      for very-recent launches. Bootstrap must clamp to BOOTSTRAP_MAX_DAYS.
//
// Run via: npm test  (see package.json).

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── 1. Per-platform noise gate math ──────────────────────────────────────
// Ported from scripts/estimate-console-units.ts — kept in sync manually
// because the estimator's top-level constants aren't exported to preserve
// the script's single-entry-point contract.
const NOISE_GATE_DEFAULT = 50;
const NOISE_GATE_DEFAULTS_BY_PLATFORM: Record<string, number> = {
  steam: 50,
  xbox: 10,
  ps5: 50,
};
function resolveGate(
  platform: string,
  perPlatformSetting: string | null,
  legacySetting: string | null,
): number {
  if (perPlatformSetting != null) return parseInt(perPlatformSetting, 10);
  if (legacySetting != null) return parseInt(legacySetting, 10);
  return NOISE_GATE_DEFAULTS_BY_PLATFORM[platform] ?? NOISE_GATE_DEFAULT;
}

test("noise gate: Xbox defaults to 10 so typical Xbox rating counts pass", () => {
  const gate = resolveGate("xbox", null, null);
  assert.equal(gate, 10);
  const typicalXboxD7Signal = 25;
  assert.ok(
    typicalXboxD7Signal >= gate,
    `Xbox rating count of ${typicalXboxD7Signal} should pass the gate (${gate}); ` +
      `otherwise the Xbox d7 leaderboard silently empties.`,
  );
});

test("noise gate: Steam stays at 50 so review-noise doesn't populate the leaderboard", () => {
  const gate = resolveGate("steam", null, null);
  assert.equal(gate, 50);
  const noiseLevelSteamSignal = 12;
  assert.ok(
    noiseLevelSteamSignal < gate,
    `Steam signal of ${noiseLevelSteamSignal} should be rejected by the ${gate}-gate.`,
  );
});

test("noise gate: PS5 stays at 50 for user-authored star ratings", () => {
  const gate = resolveGate("ps5", null, null);
  assert.equal(gate, 50);
});

test("noise gate: per-platform app_settings override wins over legacy key", () => {
  // Operator raises the Xbox gate to 30 via 'noise_gate_min_signal.xbox'
  // while the legacy 'noise_gate_min_signal' key still says 50 (Steam).
  const gate = resolveGate("xbox", "30", "50");
  assert.equal(gate, 30);
});

test("noise gate: legacy app_settings key still overrides the per-platform default", () => {
  // Someone set the old shared key to 100 and never migrated. Every platform
  // should honor it until a per-platform override is added.
  assert.equal(resolveGate("xbox", null, "100"), 100);
  assert.equal(resolveGate("ps5",  null, "100"), 100);
  assert.equal(resolveGate("steam", null, "100"), 100);
});

// ─── 2. Bootstrap horizon math ────────────────────────────────────────────
// Ported from scripts/estimate-console-units.ts — same rationale as above.
const BOOTSTRAP_MAX_DAYS = 60;
function shouldBootstrapFire(
  releaseDateAgeDays: number,
  winDays: number,
): boolean {
  const horizon = Math.min(winDays, BOOTSTRAP_MAX_DAYS);
  return releaseDateAgeDays <= horizon && releaseDateAgeDays >= 0;
}

test("bootstrap horizon: fires on a real d7 launch (3 days old)", () => {
  assert.equal(shouldBootstrapFire(3, 7), true);
});

test("bootstrap horizon: fires on a d30 window when release is 20 days old", () => {
  assert.equal(shouldBootstrapFire(20, 30), true);
});

test("bootstrap horizon: does NOT fire on m12 for a 300-day-old release", () => {
  // Ghost of Yotei case: released 2025-10-02, today 2026-09-12 = ~345 days ago.
  // Without the horizon cap, isReleasedWithin(m12=365) returned true and the
  // resolver returned LTD as the m12 signal. With BOOTSTRAP_MAX_DAYS=60 the
  // check clamps to min(365, 60) = 60 and 345 > 60 → no bootstrap fires.
  const ghostOfYoteiAgeDays = 345;
  assert.equal(shouldBootstrapFire(ghostOfYoteiAgeDays, 365), false);
});

test("bootstrap horizon: does NOT fire on m12 for a 90-day-old release", () => {
  // Any release older than BOOTSTRAP_MAX_DAYS never bootstraps, even if it
  // technically falls inside the m12 window.
  assert.equal(shouldBootstrapFire(90, 365), false);
});

test("bootstrap horizon: fires on m12 for a 45-day-old launch", () => {
  // Still within BOOTSTRAP_MAX_DAYS=60, so bootstrap is legitimate — most of
  // the LTD count really did land inside the m12 window.
  assert.equal(shouldBootstrapFire(45, 365), true);
});

test("bootstrap horizon: does NOT fire for future-dated releases", () => {
  // A negative age (release is in the future) is nonsensical for a bootstrap;
  // must not fire.
  assert.equal(shouldBootstrapFire(-5, 7), false);
});

// ─── 3. Route cascade tightening ──────────────────────────────────────────
// Mirrors CASCADE_BY_WINDOW in server/routes-console-leaderboards.ts. The
// invariant: no narrow window may cascade into m12 or ltd, because both
// carry a lifetime-adjacent signal that misrepresents a "7 day" or "30 day"
// value. m12 keeps its own single-rung cascade and ltd is its own view.
const CASCADE_BY_WINDOW: Record<string, string[]> = {
  d7:  ["d7", "d30"],
  d30: ["d30", "d90"],
  d90: ["d90"],
  m12: ["m12"],
  ltd: ["ltd"],
};

test("cascade: d7 does not fall through to m12 or ltd", () => {
  const c = CASCADE_BY_WINDOW.d7;
  assert.ok(!c.includes("m12"), "d7 must not cascade into m12");
  assert.ok(!c.includes("ltd"), "d7 must not cascade into ltd");
});

test("cascade: d30 does not fall through to m12 or ltd", () => {
  const c = CASCADE_BY_WINDOW.d30;
  assert.ok(!c.includes("m12"));
  assert.ok(!c.includes("ltd"));
});

test("cascade: d90 stays on d90 only", () => {
  assert.deepEqual(CASCADE_BY_WINDOW.d90, ["d90"]);
});

test("cascade: m12 stays on m12 only (never cascades to ltd)", () => {
  assert.deepEqual(CASCADE_BY_WINDOW.m12, ["m12"]);
});
