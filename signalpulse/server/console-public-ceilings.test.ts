import test from "node:test";
import assert from "node:assert/strict";
import { steamPublicCapRatio, overlayExceedsPublicCeiling, PUBLIC_LTD_CEILINGS, publicCeilingFor } from "./console-public-ceilings";
import { editionGroupKey } from "./console-sales-family";

const f = [0.766, 0.255];
test("Witcher 3 lifetime overlay is rejected (tracked > 65M public total)", () => {
  const r = overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("The Witcher 3: Wild Hunt"), steamUnits: 36e6, consoleFactors: f });
  assert.equal(r.exceeds, true);
});
test("the live Remastered display name resolves to the Witcher 3 ceiling", () => {
  const r = overlayExceedsPublicCeiling({ window: "ltd", familyKey: editionGroupKey("The Witcher 3: Wild Hunt — Remastered"), steamUnits: 36e6, consoleFactors: f });
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

test("Steam is capped at the public total for Phasmophobia, Valheim and Black Myth", () => {
  for (const [n, steam, cap] of [["Phasmophobia", 29.69e6, 27e6], ["Valheim", 19.85e6, 17e6], ["Black Myth: Wukong", 36.15e6, 30e6]] as const) {
    const r = steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey(n), steamUnits: steam });
    assert.ok(r); assert.ok(Math.abs(steam * r!.ratio - cap) < 1);
  }
});
test("Steam at or under the total, other windows and other titles are not capped", () => {
  assert.equal(steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Witcher 3: Wild Hunt \u2014 Remastered"), steamUnits: 36e6 }), null);
  assert.equal(steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("ARC Raiders"), steamUnits: 12.45e6 }), null);
  assert.equal(steamPublicCapRatio({ window: "d30", familyKey: editionGroupKey("Valheim"), steamUnits: 19.85e6 }), null);
  assert.equal(steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Stardew Valley"), steamUnits: 38.1e6 }), null);
  assert.equal(steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Valheim"), steamUnits: null }), null);
});

test("Black Myth regional listing resolves to the family and reduces the Steam cap", () => {
  assert.ok(publicCeilingFor(editionGroupKey("Black Myth: Wukong (Simplified Chinese)")));
  const r = steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Black Myth: Wukong"), steamUnits: 36.15e6, consoleNativeUnits: 6.92e6 });
  assert.ok(r); assert.ok(Math.abs(36.15e6 * r!.ratio - 23.08e6) < 1e3);
});
test("console units never push the Steam cap below half the total", () => {
  const r = steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Valheim"), steamUnits: 19.85e6, consoleNativeUnits: 40e6 });
  assert.ok(r); assert.ok(Math.abs(19.85e6 * r!.ratio - 8.5e6) < 1);
});
test("negative or missing console units behave as zero", () => {
  const r = steamPublicCapRatio({ window: "ltd", familyKey: editionGroupKey("Valheim"), steamUnits: 19.85e6, consoleNativeUnits: -5 });
  assert.ok(r); assert.ok(Math.abs(19.85e6 * r!.ratio - 17e6) < 1);
});
