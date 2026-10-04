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

test("combined SKUs can overtake a single-SKU title ranked above their best slot", () => {
  // title 9 holds slots 2 and 3; title 8 holds slot 1. 2^-.7 + 3^-.7 = 0.616+0.463 = 1.079 > 1
  const r = combineChartSlots([{ titleId: 8, storefrontRank: 1 }, { titleId: 9, storefrontRank: 2 }, { titleId: 9, storefrontRank: 3 }]);
  assert.equal(r[0].titleId, 9);
  assert.equal(r[1].titleId, 8);
});

test("ranks are dense 1..N and ignore invalid slots", () => {
  const r = combineChartSlots([{ titleId: 1, storefrontRank: 4 }, { titleId: 2, storefrontRank: 0 }, { titleId: 3, storefrontRank: 9 }]);
  assert.deepEqual(r.map(x => x.rank), [1, 2]);
});
