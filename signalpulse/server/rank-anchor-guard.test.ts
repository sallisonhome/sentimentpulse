import { test } from "node:test";
import assert from "node:assert/strict";
import { capRankAnchorFloor, enforceRankAnchorWindows } from "./rank-anchor-guard";

test("Samson shape: floor of 311,931 is capped at 3x the ratings-derived lifetime units", () => {
  const r = capRankAnchorFloor(311931, { unitsMid: 50143, signalValue: 307 });
  assert.equal(r.capped, true);
  assert.equal(r.floor, 150429);
});
test("thin ratings, gated or missing lifetime rows keep the floor (the reason the floor exists)", () => {
  assert.equal(capRankAnchorFloor(311931, { unitsMid: 900, signalValue: 61 }).capped, false);
  assert.equal(capRankAnchorFloor(311931, { unitsMid: 50143, signalValue: 307, gatedReason: "no_signal" }).capped, false);
  assert.equal(capRankAnchorFloor(311931, { unitsMid: null, signalValue: 500 }).capped, false);
  assert.equal(capRankAnchorFloor(311931, undefined).capped, false);
});
test("a floor already under the cap is untouched", () => {
  const r = capRankAnchorFloor(90000, { unitsMid: 50143, signalValue: 307 });
  assert.deepEqual([r.capped, r.floor], [false, 90000]);
});
const row = (window: string, u: number | null, method = "x", gated: string | null = null) =>
  ({ window, unitsMid: u, ownersLow: u && u * 0.8, ownersMid: u && u * 0.9, ownersHigh: u && u * 1.1, method, gatedReason: gated });
test("d30 and later windows are raised to the floored d7, with owners scaled", () => {
  const rows = [row("d7", 150000, "rank_anchor:xbox_api_top_paid+ratings_cap_v1"), row("d30", 50000), row("d90", 200000), row("m12", 40000)];
  assert.equal(enforceRankAnchorWindows(rows, false), 2);
  assert.equal(rows[1].unitsMid, 150000);
  assert.equal(rows[1].ownersMid, 135000);
  assert.match(rows[1].method, /window_floor_rank_anchor_v1$/);
  assert.equal(rows[2].unitsMid, 200000);   // already larger: untouched
  assert.equal(rows[3].unitsMid, 150000);
});
test("no change without the floor tag, for override-anchored titles, or for gated/empty windows", () => {
  const plain = [row("d7", 150000, "ltd-anchor-median-v03"), row("d30", 50000)];
  assert.equal(enforceRankAnchorWindows(plain, false), 0);
  const floored = () => [row("d7", 150000, "rank_anchor:psn_api_sales30"), row("d30", 50000), row("d90", null), row("m12", 1000, "x", "no_signal")];
  assert.equal(enforceRankAnchorWindows(floored(), true), 0);
  const g = floored(); assert.equal(enforceRankAnchorWindows(g, false), 1);
  assert.equal(g[2].unitsMid, null); assert.equal(g[3].unitsMid, 1000);
});
