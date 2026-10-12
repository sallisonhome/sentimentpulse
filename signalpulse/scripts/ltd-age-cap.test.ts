import { test } from "node:test";
import assert from "node:assert/strict";
import { ageCoveringWindow, ageWindowCapFor, type EstimateRowLike } from "./ltd-age-cap";

function rows(...vals: [string, number | null][]): EstimateRowLike[] {
  return vals.map(([w, u]) => ({ window: w, gatedReason: null, unitsMid: u }));
}

function gated(w: string, reason: string): EstimateRowLike {
  return { window: w, gatedReason: reason, unitsMid: null };
}

test("ageCoveringWindow maps age to the right window", () => {
  assert.equal(ageCoveringWindow(0), "d7");
  assert.equal(ageCoveringWindow(6), "d7");
  assert.equal(ageCoveringWindow(7), "d7");
  assert.equal(ageCoveringWindow(8), "d30");
  assert.equal(ageCoveringWindow(30), "d30");
  assert.equal(ageCoveringWindow(31), "d90");
  assert.equal(ageCoveringWindow(90), "d90");
  assert.equal(ageCoveringWindow(91), "m12");
  assert.equal(ageCoveringWindow(365), "m12");
});

test("cap returns the age-window's units when present and ungated", () => {
  const rs = rows(["d7", 500], ["d30", 1000], ["d90", 2000], ["m12", 3000], ["ltd", 9999]);
  assert.equal(ageWindowCapFor(5, rs), 500);
  assert.equal(ageWindowCapFor(20, rs), 1000);
  assert.equal(ageWindowCapFor(60, rs), 2000);
  assert.equal(ageWindowCapFor(200, rs), 3000);
});

test("cap is null when the age-window row is gated", () => {
  const rs = rows(["d7", null], ["d30", 1000]);
  rs[0] = gated("d7", "insufficient_history");
  assert.equal(ageWindowCapFor(5, rs), null);
});

test("cap is null when the age-window row is missing", () => {
  const rs = rows(["d7", 500]);
  assert.equal(ageWindowCapFor(100, rs), null);
});

test("cap is null for unknown age (no release date)", () => {
  assert.equal(ageWindowCapFor(null, rows(["d30", 1000])), null);
});

test("cap is null for titles >= 366 days old (accumulator regime handles those)", () => {
  assert.equal(ageWindowCapFor(366, rows(["m12", 1000])), null);
  assert.equal(ageWindowCapFor(1000, rows(["m12", 1000])), null);
});

test("cap is null for negative ages (future release date)", () => {
  assert.equal(ageWindowCapFor(-5, rows(["d7", 500])), null);
});

test("a gated age-window row yields no cap even when other windows exist", () => {
  const rs = rows(["d30", 1000], ["m12", 5000]);
  const rs2 = [...rs, gated("d7", "signal_too_small")];
  assert.equal(ageWindowCapFor(3, rs2), null);
});
