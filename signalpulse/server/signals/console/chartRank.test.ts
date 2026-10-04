import test from "node:test";
import assert from "node:assert/strict";
import { combineChartSlots } from "./chartRank";

test("one slot per title keeps chart order", () => {
  const r = combineChartSlots([{ titleId: 5, storefrontRank: 1 }, { titleId: 6, storefrontRank: 2 }, { titleId: 7, storefrontRank: 3 }]);
  assert.deepEqual(r.map(x => [x.titleId, x.rank]), [[5, 1], [6, 2], [7, 3]]);
});

test("a title's worse SKU never overwrites its better SKU", () => {
  const r = combineChartSlots([{ titleId: 1, storefrontRank: 1 }, { titleId: 2, storefrontRank: 2 }, { titleId: 1, storefrontRank: 7 }]);
  assert.equal(r.find(x => x.titleId === 1)!.rank, 1);
  assert.equal(r.find(x => x.titleId === 1)!.slots, 2);
});

test("a single slot keeps its exact store position (Samson = 48 on PS5)", () => {
  const r = combineChartSlots([{ titleId: 1, storefrontRank: 47 }, { titleId: 2, storefrontRank: 48 }]);
  assert.equal(r.find(x => x.titleId === 2)!.rank, 48);
});

test("combined SKUs rank at least as high as their best slot", () => {
  const r = combineChartSlots([{ titleId: 9, storefrontRank: 2 }, { titleId: 9, storefrontRank: 3 }, { titleId: 8, storefrontRank: 1 }]);
  assert.equal(r.find(x => x.titleId === 9)!.rank, 1);
  assert.ok(r.find(x => x.titleId === 9)!.rank <= 2);
});

test("invalid slots are ignored", () => {
  const r = combineChartSlots([{ titleId: 1, storefrontRank: 4 }, { titleId: 2, storefrontRank: 0 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].rank, 4);
});
