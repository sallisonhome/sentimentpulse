import test from "node:test";
import assert from "node:assert/strict";
import { editionGroupKey } from "./console-sales-family";

// Exact live names read from the API on 2026-10-03.
test("Xbox pre-order listings join the base game family (live names)", () => {
  assert.equal(editionGroupKey("ACE COMBAT 8: WINGS OF THEVE Deluxe Edition Pre-Order"), editionGroupKey("Ace Combat 8: Wings of Theve"));
  assert.equal(editionGroupKey("ACE COMBAT 8: WINGS OF THEVE Deluxe Edition Pre-Order"), editionGroupKey("ACE COMBAT 8: WINGS OF THEVE"));
  assert.equal(editionGroupKey("Gears of War: E-Day Premium Edition Pre-Order"), "gears of war: e-day");
});
test("pre-order variants strip only as a trailing qualifier", () => {
  assert.equal(editionGroupKey("Some Game Pre-Order"), "some game");
  assert.equal(editionGroupKey("Some Game: Preorder"), "some game");
  assert.equal(editionGroupKey("Pre-Order Heroes"), "pre-order heroes");
  assert.equal(editionGroupKey("Some Game Deluxe Edition"), "some game");
});
