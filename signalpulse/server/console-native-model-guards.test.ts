import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_NATIVE_MODEL_GUARDS, nativeModelGuardFor } from "./console-native-model-guards";

test("the shipped native-model guards are the v1 batch plus the 22 audit-widened v2 rows", () => {
  const ids = CONSOLE_NATIVE_MODEL_GUARDS.map((g) => g.titleId);
  // v1: the three titles the user named.
  for (const id of [11188, 11179, 10370]) {
    assert.ok(ids.includes(id), `v1 guard ${id} present`);
  }
  // v2: the 22 audit-widened titles, d90/m12 only.
  const V2 = [10319, 10320, 10350, 10352, 10362, 10402, 10513, 10520, 10535,
              10565, 10624, 10635, 10636, 10645, 10651, 10691, 10876, 11035,
              11157, 11192, 11337, 11345];
  for (const id of V2) {
    assert.ok(ids.includes(id), `v2 guard ${id} present`);
  }
  assert.equal(CONSOLE_NATIVE_MODEL_GUARDS.filter((g) => g.policyVersion === "native_model_guard_v1").length, 3);
  assert.equal(CONSOLE_NATIVE_MODEL_GUARDS.filter((g) => g.policyVersion === "native_model_guard_v2").length, V2.length);
  // v3: the RDR2 PS4-backcompat PS5 row (title_id 11561), all windowed rows guarded.
  const v3 = CONSOLE_NATIVE_MODEL_GUARDS.filter((g) => g.policyVersion === "native_model_guard_v3");
  assert.equal(v3.length, 1);
  assert.equal(v3[0].titleId, 11561);
  assert.equal(v3[0].platform, "ps5");
  assert.deepEqual(v3[0].windows, ["d7", "d30", "d90", "m12"]); // LTD deliberately not guarded
  for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
    assert.ok(g.reason.length > 20, "each guard carries an audit reason");
    assert.ok(g.policyVersion.length > 0, "each guard carries a policy version");
    assert.ok(g.windows.length > 0, "each guard carries an explicit window scope");
  }
});

test("nativeModelGuardFor matches only the exact (family, platform, window) triple", () => {
  // TLOU rows: d7/d30/d90/m12 guarded (LTD deliberately not guarded — the
  // durable LTD fix is the public-anchor + AAA-curve work, not a guard).
  for (const id of [11188, 11179]) {
    for (const win of ["d7", "d30", "d90", "m12"]) {
      assert.ok(nativeModelGuardFor([id], "ps5", win), `${id}/ps5/${win} is guarded`);
    }
    assert.equal(nativeModelGuardFor([id], "ps5", "ltd"), null, `${id}/ps5/ltd is NOT guarded`);
  }
  // GoW Ragnarök: d90/m12 only (2026-10-13 scoped fix; d7/d30/LTD keep the
  // IP override pending the public-anchor + AAA-curve work).
  for (const win of ["d90", "m12"]) {
    assert.ok(nativeModelGuardFor([10370], "ps5", win), `10370/ps5/${win} is guarded`);
  }
  for (const win of ["d7", "d30", "ltd"]) {
    assert.equal(nativeModelGuardFor([10370], "ps5", win), null, `10370/ps5/${win} is NOT guarded`);
  }
  // Wrong platform.
  assert.equal(nativeModelGuardFor([11188], "xbox", "d30"), null);
  assert.equal(nativeModelGuardFor([11179], "steam", "d30"), null);
  assert.equal(nativeModelGuardFor([10370], "xbox", "d90"), null);
  // Wrong title.
  assert.equal(nativeModelGuardFor([11296], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor([11389], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor([0], "ps5", "d30"), null);
  // Guarded title inside a larger family is still protected (edition grouping).
  assert.ok(nativeModelGuardFor([99999, 11188], "ps5", "d30"));
  assert.ok(nativeModelGuardFor([11179, 99998], "ps5", "d30"));
  assert.ok(nativeModelGuardFor([10370, 99997], "ps5", "d90"));
  // Empty or missing family.
  assert.equal(nativeModelGuardFor([], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor(undefined, "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor(null, "ps5", "d30"), null);
});

test("guards do not leak to an unsupported window", () => {
  assert.equal(nativeModelGuardFor([11188], "ps5", "d1"), null);
  assert.equal(nativeModelGuardFor([11188], "ps5", "bogus"), null);
  assert.equal(nativeModelGuardFor([10370], "ps5", "d1"), null);
  // v2 rows are d90/m12 only.
  for (const id of [10320, 10513, 10402]) {
    for (const w of ["d7", "d30", "ltd", "d1"]) {
      assert.equal(nativeModelGuardFor([id], "ps5", w), null, `${id}/ps5/${w} is NOT guarded`);
    }
    for (const w of ["d90", "m12"]) {
      assert.ok(nativeModelGuardFor([id], "ps5", w), `${id}/ps5/${w} is guarded`);
    }
  }
});

test("the shipped guards carry an audit reason and policy version", () => {
  for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
    assert.ok(g.reason.includes("Steam×9 IP override") || g.reason.includes("ceiling clamp") || g.reason.includes("native") || g.reason.includes("ratings-driven"), `guard reason cites the override, clamp, native baseline, or ratings-driven directive: ${g.reason}`);
    assert.ok(["native_model_guard_v1", "native_model_guard_v2", "native_model_guard_v3"].includes(g.policyVersion),
      `guard policyVersion is a known version: ${g.policyVersion}`);
  }
});
