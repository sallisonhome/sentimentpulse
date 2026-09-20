import { test } from "node:test";
import assert from "node:assert/strict";
import { revenueSummary } from "./console-revenue-share";

for (const window of ["d7", "d30", "d90", "m12", "ltd"]) {
  test(`family revenue totals and shares: ${window}`, () => {
    const summary = revenueSummary([
      { revenueSteam: 100, revenuePs5: 50, revenueXbox: 25 },
      { revenueSteam: 100, revenuePs5: 50, revenueXbox: 75 },
    ], window);
    assert.equal(summary.window, window);
    assert.equal(summary.titleCount, 2);
    assert.equal(summary.combinedRevenueUsd, 400);
    assert.deepEqual(summary.platforms.map(p => p.sharePct), [50, 25, 25]);
    assert.deepEqual(summary.platforms.map(p => p.revenueUsd), [200, 100, 100]);
  });
}
test("no revenue means unavailable shares rather than misleading zero shares", () => {
  for (const rows of [[], [{ revenueSteam: 0, revenuePs5: 0, revenueXbox: 0 }]]) {
    const summary = revenueSummary(rows, "d7");
    assert.equal(summary.combinedRevenueUsd, 0);
    assert.ok(summary.platforms.every(p => p.sharePct === null));
  }
});
test("single platform family is 100 percent; absent platforms are zero", () => {
  const summary = revenueSummary([{ revenueSteam: 123.45, revenuePs5: 0, revenueXbox: 0 }], "ltd");
  assert.deepEqual(summary.platforms.map(p => p.sharePct), [100, 0, 0]);
});
