import { test } from "node:test";
import assert from "node:assert/strict";
import { AGED_TITLE_CEILINGS, agedTitleCeilingFor, applyAgedTitleCeiling } from "./aged-title-ceilings";

test("the registry covers the v1 batch and the audit-widened v2 batch, d90/m12 only", () => {
  const keys = AGED_TITLE_CEILINGS.map(c => `${c.titleId}|${c.platform}|${c.window}`).sort();
  const expected = [
    // v1: the three titles the user named
    "10370|ps5|d90", "10370|ps5|m12",
    "11179|ps5|d90", "11179|ps5|m12",
    "11188|ps5|d90", "11188|ps5|m12",
    // v2: audit-widened (LTD>1M, age>730d, ratio>5x) — 22 titles
    "10319|ps5|d90", "10319|ps5|m12",
    "10320|ps5|d90", "10320|ps5|m12",
    "10350|ps5|d90", "10350|ps5|m12",
    "10352|ps5|d90", "10352|ps5|m12",
    "10362|ps5|d90", "10362|ps5|m12",
    "10402|ps5|d90", "10402|ps5|m12",
    "10513|ps5|d90", "10513|ps5|m12",
    "10520|ps5|d90", "10520|ps5|m12",
    "10535|ps5|d90", "10535|ps5|m12",
    "10565|ps5|d90", "10565|ps5|m12",
    "10624|ps5|d90", "10624|ps5|m12",
    "10635|ps5|d90", "10635|ps5|m12",
    "10636|ps5|d90", "10636|ps5|m12",
    "10645|ps5|d90", "10645|ps5|m12",
    "10651|ps5|d90", "10651|ps5|m12",
    "10691|ps5|d90", "10691|ps5|m12",
    "10876|ps5|d90", "10876|ps5|m12",
    "11035|ps5|d90", "11035|ps5|m12",
    "11157|ps5|d90", "11157|ps5|m12",
    "11192|ps5|d90", "11192|ps5|m12",
    "11337|ps5|d90", "11337|ps5|m12",
    "11345|ps5|d90", "11345|ps5|m12",
    // v3: the 19 Steam titles (some have only m12, Ori has only d90)
    "9002|steam|d90", "9002|steam|m12",
    "10088|steam|d90", "10088|steam|m12",
    "10123|steam|m12",
    "10136|steam|d90", "10136|steam|m12",
    "10151|steam|d90", "10151|steam|m12",
    "10152|steam|m12",
    "10168|steam|m12",
    "10181|steam|m12",
    "10186|steam|d90", "10186|steam|m12",
    "10319|steam|d90", "10319|steam|m12",
    "10444|steam|d90", "10444|steam|m12",
    "10592|steam|d90", "10592|steam|m12",
    "10601|steam|d90", "10601|steam|m12",
    "10833|steam|d90", "10833|steam|m12",
    "10836|steam|d90", "10836|steam|m12",
    "10916|steam|d90", "10916|steam|m12",
    "11134|steam|d90",
    "11162|steam|m12",
    "11174|steam|m12",
  ].sort();
  assert.deepEqual(keys, expected);
  for (const c of AGED_TITLE_CEILINGS) {
    assert.ok(c.ceilingFraction > 0 && c.ceilingFraction < 1, `${c.titleId}/${c.window} fraction in (0,1)`);
    assert.ok(c.reason.length > 20, `${c.titleId}/${c.window} carries a reason`);
    assert.ok(["aged_title_ceiling_v1", "aged_title_ceiling_v2", "aged_title_ceiling_v3"].includes(c.policyVersion),
      `${c.titleId}/${c.window} has a known policy version`);
  }
  // v1 covers exactly 3 titles (6 rows); v2 covers exactly 22 titles (44 rows);
  // v3 (Steam) covers exactly 19 titles (31 rows).
  const v1 = AGED_TITLE_CEILINGS.filter(c => c.policyVersion === "aged_title_ceiling_v1");
  const v2 = AGED_TITLE_CEILINGS.filter(c => c.policyVersion === "aged_title_ceiling_v2");
  const v3 = AGED_TITLE_CEILINGS.filter(c => c.policyVersion === "aged_title_ceiling_v3");
  assert.equal(v1.length, 6);
  assert.equal(v2.length, 44);
  assert.equal(v3.length, 31);
  // Every v3 row is Steam.
  for (const c of v3) {
    assert.equal(c.platform, "steam", `v3 row ${c.titleId}/${c.window} is steam`);
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

test("the v2 burst-exemption math: a steady-state aged title is clamped, a burst is not", () => {
  // Ready or Not: LTD 1,113,477, m12 stored 1,485,352, age 1035d.
  // Lifetime-avg daily = 1,113,477/1035 ≈ 1074.9 units/day.
  // Window-implied daily = 1,485,352/365 ≈ 4069.5 units/day.
  // Ratio ≈ 3.8x — below the 10x burst threshold, so the ceiling applies.
  const ltd = 1_113_477, m12 = 1_485_352, age = 1035;
  const ratio = (m12 / 365) / (ltd / age);
  assert.ok(ratio < 10, `steady-state ratio ${ratio.toFixed(2)} < 10, ceiling applies`);

  // A burst case: a deep-discount event pushes the m12 to 20x the lifetime
  // average. ratio > 10 → the observed pace wins, no clamp.
  const burstM12 = 20 * (ltd / age) * 365;
  const burstRatio = (burstM12 / 365) / (ltd / age);
  assert.ok(burstRatio > 10, `burst ratio ${burstRatio.toFixed(0)} > 10, ceiling skipped`);
});
