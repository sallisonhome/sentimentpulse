import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_NATIVE_MODEL_GUARDS, nativeModelGuardFor } from "./console-native-model-guards";

test("the shipped native-model guards are the two TLOU PS5 rows", () => {
  assert.deepEqual(
    CONSOLE_NATIVE_MODEL_GUARDS.map((g) => [g.titleId, g.platform]),
    [[11188, "ps5"], [11179, "ps5"]],
  );
  for (const g of CONSOLE_NATIVE_MODEL_GUARDS) {
    assert.ok(g.reason.length > 20, "each guard carries an audit reason");
    assert.ok(g.policyVersion.length > 0, "each guard carries a policy version");
    assert.ok(g.windows.length > 0, "each guard carries an explicit window scope");
  }
});

test("nativeModelGuardFor matches only the exact (family, platform, window) triple", () => {
  for (const win of ["d7", "d30", "d90", "m12", "ltd"]) {
    assert.ok(nativeModelGuardFor([11188], "ps5", win), `11188/ps5/${win} is guarded`);
    assert.ok(nativeModelGuardFor([11179], "ps5", win), `11179/ps5/${win} is guarded`);
  }
  // Wrong platform.
  assert.equal(nativeModelGuardFor([11188], "xbox", "d30"), null);
  assert.equal(nativeModelGuardFor([11179], "steam", "d30"), null);
  // Wrong title.
  assert.equal(nativeModelGuardFor([11296], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor([11389], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor([0], "ps5", "d30"), null);
  // Guarded title inside a larger family is still protected (edition grouping).
  assert.ok(nativeModelGuardFor([99999, 11188], "ps5", "d30"));
  assert.ok(nativeModelGuardFor([11179, 99998], "ps5", "d30"));
  // Empty or missing family.
  assert.equal(nativeModelGuardFor([], "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor(undefined, "ps5", "d30"), null);
  assert.equal(nativeModelGuardFor(null, "ps5", "d30"), null);
});

test("guards do not leak to an unsupported window", () => {
  assert.equal(nativeModelGuardFor([11188], "ps5", "d1"), null);
  assert.equal(nativeModelGuardFor([11188], "ps5", "bogus"), null);
});
