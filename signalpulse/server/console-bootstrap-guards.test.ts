import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_BOOTSTRAP_GUARDS, isBootstrapIneligible } from "./console-bootstrap-guards";

test("the shipped guards are the Mafia III DE PS5 and DD2 Dark Arisen PS5 listings", () => {
  assert.deepEqual(
    CONSOLE_BOOTSTRAP_GUARDS.map((g) => [g.titleId, g.platform]),
    [[11389, "ps5"], [11352, "ps5"]],
  );
  for (const g of CONSOLE_BOOTSTRAP_GUARDS) {
    assert.ok(g.reason.length > 20, "each guard carries an audit reason");
    assert.match(g.reason, /inherits the (DE|DD2) concept's [\d,]+-rating pool/, g.reason);
  }
});

test("isBootstrapIneligible matches only the exact (title, platform) pair", () => {
  assert.equal(isBootstrapIneligible(11389, "ps5"), true);
  assert.equal(isBootstrapIneligible(11352, "ps5"), true);
  assert.equal(isBootstrapIneligible(11389, "xbox"), false);
  assert.equal(isBootstrapIneligible(11352, "xbox"), false);
  assert.equal(isBootstrapIneligible(11296, "ps5"), false);
  assert.equal(isBootstrapIneligible(0, "ps5"), false);
});
