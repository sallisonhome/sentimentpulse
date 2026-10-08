import test from "node:test";
import assert from "node:assert/strict";
import { ratioStepSplit, spreadRestatement, RATIO_STEP_SPREAD_FAMILIES } from "./daily-gap-allocation";

const M = "calibrated_from_actuals_v1+steam_histogram_nonoverlap_v1";

test("Control Resonant 2026-10-06 to 10-07 live numbers split into the day's sales and a restatement", () => {
  const s = ratioStepSplit({ units: 394528, signal: 9814, method: M }, { units: 580118, signal: 10159, method: M })!;
  assert.ok(Math.abs(s.dayUnits - 345 * (580118 / 10159)) < 1e-6);
  assert.ok(Math.abs(s.dayUnits + s.restatedUnits - (580118 - 394528)) < 1e-6);
  assert.ok(s.dayUnits > 19000 && s.dayUnits < 20500);
  assert.ok(s.restatedUnits > 165000 && s.restatedUnits < 167000);
});

test("Halloween live numbers: the blank day gets its own sales, the rest is restated", () => {
  const s = ratioStepSplit({ units: 579049, signal: 14404, method: M }, { units: 827321, signal: 14488, method: M })!;
  assert.ok(s.dayUnits > 4700 && s.dayUnits < 4900);
  assert.ok(Math.abs(s.dayUnits + s.restatedUnits - 248272) < 1e-6);
});

test("no split for ordinary days, small ratio moves, method changes, or missing/flat signal", () => {
  assert.equal(ratioStepSplit({ units: 1000, signal: 25, method: M }, { units: 1040, signal: 26, method: M }), null);
  assert.equal(ratioStepSplit({ units: 1000, signal: 25, method: M }, { units: 1100, signal: 25, method: M }), null);
  assert.equal(ratioStepSplit({ units: 1000, signal: 25, method: M }, { units: 1500, signal: 26, method: "other_v1" }), null);
  assert.equal(ratioStepSplit({ units: 1000, signal: null, method: M }, { units: 1500, signal: 26, method: M }), null);
  assert.equal(ratioStepSplit({ units: 1000, signal: 25, method: M }, { units: 900, signal: 26, method: M }), null);
});

test("spread keeps the curve shape, conserves the total, and never fills null days", () => {
  const daily: Record<string, number | null> = { "2026-10-01": 100, "2026-10-02": 300, "2026-10-03": null, "2026-10-04": 600, "2026-10-07": 50 };
  const before = 100 + 300 + 600;
  spreadRestatement(daily, "2026-10-07", 1000);
  assert.equal(daily["2026-10-03"], null);
  assert.equal(daily["2026-10-07"], 50);
  assert.ok(Math.abs((daily["2026-10-01"]! + daily["2026-10-02"]! + daily["2026-10-04"]!) - (before + 1000)) < 1e-9);
  assert.ok(Math.abs(daily["2026-10-02"]! / daily["2026-10-01"]! - 3) < 1e-9);
  assert.ok(Math.abs(daily["2026-10-04"]! / daily["2026-10-02"]! - 2) < 1e-9);
});

test("scope is exactly the two reviewed families", () => {
  assert.deepEqual(Array.from(RATIO_STEP_SPREAD_FAMILIES).sort(), ["control resonant", "halloween: the game"]);
});

import { reshapeLaunchWeek, LAUNCH_WEEK_REVIEW_FAMILIES } from "./daily-gap-allocation";

test("launch week reshape: conserves the total, follows weights, leaves other days alone, fails closed", () => {
  const days = ["2026-09-14", "2026-09-15", "2026-09-16"];
  const d: Record<string, number | null> = { "2026-09-15": 900, "2026-09-16": 100, "2026-09-17": 55 };
  assert.equal(reshapeLaunchWeek(d, days, [1, 2, 2]), true);
  assert.ok(Math.abs((d["2026-09-14"] as number) + (d["2026-09-15"] as number) + (d["2026-09-16"] as number) - 1000) < 1e-9);
  assert.ok(Math.abs((d["2026-09-15"] as number) - 400) < 1e-9);
  assert.equal(d["2026-09-17"], 55);
  const e: Record<string, number | null> = { "2026-09-15": 10 };
  assert.equal(reshapeLaunchWeek(e, days, [1, undefined, 2]), false);
  assert.equal(reshapeLaunchWeek(e, days, [0, 0, 0]), false);
  assert.equal(reshapeLaunchWeek({}, days, [1, 1, 1]), false);
  assert.equal(e["2026-09-15"], 10);
  assert.deepEqual(Object.keys(LAUNCH_WEEK_REVIEW_FAMILIES), ["halloween: the game"]);
});
