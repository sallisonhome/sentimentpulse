import { test } from "node:test";
import assert from "node:assert/strict";
import { AGED_TITLE_CEILINGS, agedTitleCeilingFor, applyAgedTitleCeiling } from "./aged-title-ceilings";

test("the registry covers exactly the three named titles, d90/m12 only", () => {
  const keys = AGED_TITLE_CEILINGS.map(c => `${c.titleId}|${c.platform}|${c.window}`).sort();
  assert.deepEqual(keys, [
    "10370|ps5|d90", "10370|ps5|m12",
    "11179|ps5|d90", "11179|ps5|m12",
    "11188|ps5|d90", "11188|ps5|m12",
  ]);
  for (const c of AGED_TITLE_CEILINGS) {
    assert.ok(c.ceilingFraction > 0 && c.ceilingFraction < 1, `${c.titleId}/${c.window} fraction in (0,1)`);
    assert.ok(c.reason.length > 20, `${c.titleId}/${c.window} carries a reason`);
    assert.equal(c.policyVersion, "aged_title_ceiling_v1");
  }
});

test("agedTitleCeilingFor matches the exact triple and family members", () => {
  assert.ok(agedTitleCeilingFor([10370], "ps5", "d90"));
  assert.ok(agedTitleCeilingFor([99999, 10370], "ps5", "m12"));
  // Wrong platform / window / title.
  assert.equal(agedTitleCeilingFor([10370], "xbox", "d90"), null);
  assert.equal(agedTitleCeilingFor([10370], "ps5", "d7"), null);
  assert.equal(agedTitleCeilingFor([10370], "ps5", "ltd"), null);
  assert.equal(agedTitleCeilingFor([11296], "ps5", "d90"), null);
  assert.equal(agedTitleCeilingFor([], "ps5", "d90"), null);
  assert.equal(agedTitleCeilingFor(undefined, "ps5", "d90"), null);
});

test("applyAgedTitleCeiling clamps the signal to the fraction of LTD", () => {
  // GoW Ragnarök m12: LTD 210,074 ratings × 0.0206 = 4,328.
  const c = AGED_TITLE_CEILINGS.find(x => x.titleId === 10370 && x.window === "m12")!;
  const r = applyAgedTitleCeiling(210_074, c);
  assert.equal(r.signal, 4_328);
  assert.equal(r.clamped, true);
  // Null / non-finite LTD passes through as null (not NaN).
  assert.deepEqual(applyAgedTitleCeiling(null, c), { signal: null, clamped: false });
  const nan = applyAgedTitleCeiling(NaN, c);
  assert.equal(nan.clamped, false);
  assert.ok(nan.signal == null || Number.isNaN(nan.signal) === false || nan.signal === null,
    "NaN input yields a null-ish signal, never a published NaN");
});

test("the TLOU Part II Remastered ceilings are burst-adjusted (higher than the raw curve)", () => {
  // The HBO S2 bump is real; the ceiling for 11179 is 3x the curve value so
  // the bump is preserved while the linear extrapolation is still bounded.
  const d90 = AGED_TITLE_CEILINGS.find(x => x.titleId === 11179 && x.window === "d90")!;
  const m12 = AGED_TITLE_CEILINGS.find(x => x.titleId === 11179 && x.window === "m12")!;
  // Curve values at age ~633d: d90 ~8%, m12 ~11%. Burst-adjusted 3x.
  assert.ok(d90.ceilingFraction >= 0.20 && d90.ceilingFraction <= 0.30,
    `11179 d90 fraction ${d90.ceilingFraction} in burst-adjusted range`);
  assert.ok(m12.ceilingFraction >= 0.28 && m12.ceilingFraction <= 0.40,
    `11179 m12 fraction ${m12.ceilingFraction} in burst-adjusted range`);
  // And they must be higher than the steady-state titles' fractions.
  const gowM12 = AGED_TITLE_CEILINGS.find(x => x.titleId === 10370 && x.window === "m12")!;
  assert.ok(m12.ceilingFraction > gowM12.ceilingFraction, "11179 m12 ceiling > 10370 m12 ceiling (burst)");
});
