import test from "node:test";
import assert from "node:assert/strict";
import { overlayExceedsPublicCeiling, PUBLIC_LTD_CEILINGS, publicCeilingFor } from "./console-public-ceilings";
import { editionGroupKey } from "./console-sales-family";

const f = [0.766, 0.255];
test("Witcher 3 lifetime overlay is rejected (tracked > 65M public total)", () => {
  const r = overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("The Witcher 3: Wild Hunt"), steamUnits: 36e6, consoleFactors: f });
  assert.equal(r.exceeds, true);
});
test("ARC Raiders and Ready or Not are rejected", () => {
  assert.equal(overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("ARC Raiders"), steamUnits: 12.45e6, consoleFactors: f }).exceeds, true);
  assert.equal(overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("Ready or Not"), steamUnits: 11.45e6, consoleFactors: f }).exceeds, true);
});
test("below the ceiling is kept", () => {
  assert.equal(overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("ARC Raiders"), steamUnits: 5e6, consoleFactors: f }).exceeds, false);
});
test("only the lifetime window is guarded", () => {
  for (const w of ["d7", "d30", "d90", "m12"])
    assert.equal(overlayExceedsPublicCeiling({ window: w, familyKey: editionGroupKey("The Witcher 3: Wild Hunt"), steamUnits: 36e6, consoleFactors: f }).exceeds, false);
});
test("families without a ceiling are untouched, including Saber's Space Marine 2", () => {
  assert.equal(overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("Warhammer 40,000: Space Marine 2"), steamUnits: 7e6, consoleFactors: f }).exceeds, false);
  assert.equal(overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("Stardew Valley"), steamUnits: 38e6, consoleFactors: f }).exceeds, false);
});
test("every ceiling has a dated https source, resolves to a key, and no ceiling is below the stated figure", () => {
  for (const c of PUBLIC_LTD_CEILINGS) {
    assert.match(c.source, /^https?:\/\//); assert.match(c.asOf, /^\d{4}-\d\d-\d\d$/);
    assert.ok(c.ceilingUnits >= c.statedUnits); assert.ok(publicCeilingFor(editionGroupKey(c.name)));
  }
});
