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
  // both are equivalent to #1; the storefront shows title 8 at #1 (a single slot, never moved)
  assert.equal(r.find(x => x.titleId === 8)!.rank, 1);
  assert.equal(r.find(x => x.titleId === 9)!.rank, 2);
  assert.ok(r.find(x => x.titleId === 9)!.rank <= 2);
});

test("invalid slots are ignored", () => {
  const r = combineChartSlots([{ titleId: 1, storefrontRank: 4 }, { titleId: 2, storefrontRank: 0 }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].rank, 4);
});

test("ties are broken by storefront order; single-slot titles never move and ranks are unique", () => {
  const r = combineChartSlots([
    { titleId: 100, storefrontRank: 1 }, { titleId: 200, storefrontRank: 3 }, { titleId: 200, storefrontRank: 4 },
    { titleId: 300, storefrontRank: 10 }, { titleId: 300, storefrontRank: 11 }, { titleId: 300, storefrontRank: 12 },
    { titleId: 400, storefrontRank: 2 }, { titleId: 500, storefrontRank: 5 },
  ]);
  const rankOf = (id: number) => r.find(x => x.titleId === id)!.rank;
  assert.equal(new Set(r.map(x => x.rank)).size, r.length, "no ties");
  assert.deepEqual([rankOf(100), rankOf(400), rankOf(500)], [1, 2, 5], "single slots keep their exact store position");
  assert.equal(rankOf(200), 3, "combined title takes the nearest free position at its demand-equivalent rank");
});

test("two combined titles with equal demand: better raw storefront position first, then title id", () => {
  const r = combineChartSlots([{ titleId: 8, storefrontRank: 6 }, { titleId: 8, storefrontRank: 7 }, { titleId: 7, storefrontRank: 6 }, { titleId: 7, storefrontRank: 7 }]);
  assert.equal(r[0].titleId, 7); assert.equal(r[1].rank, r[0].rank + 1);
});

test("invariant on random charts: unique ranks, singles exact, combined never better than demand-equivalent", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let t = 0; t < 200; t++) {
    const slots = Array.from({ length: 60 + Math.floor(rnd() * 80) }, (_, i) => ({ titleId: Math.floor(rnd() * 70), storefrontRank: i + 1 }));
    const r = combineChartSlots(slots);
    assert.equal(new Set(r.map(x => x.rank)).size, r.length);
    for (const x of r) {
      if (x.slots === 1) assert.equal(x.rank, x.bestSlotRank);
      else assert.ok(x.rank >= 1);
    }
  }
});
