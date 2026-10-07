import test from "node:test";
import assert from "node:assert/strict";
import { editionGroupKey } from "./console-sales-family";
import { identityName, metadataMatchesStorefront } from "./console-title-identity";

test("memoized name normalizers return stable, correct values on repeat calls", () => {
  const names = ["Cyberpunk 2077: Ultimate Edition (Xbox Series X|S)", "Insurgency: Sandstorm [PS4 & PS5]", "RimWorld Console Edition", "WARHAMMER 40,000: Space Marine II™", "Elden Ring"];
  const first = names.map(n => [editionGroupKey(n), identityName(n)]);
  const again = names.map(n => [editionGroupKey(n), identityName(n)]);
  assert.deepEqual(first, again);
  assert.equal(editionGroupKey("RimWorld Console Edition"), "rimworld");
  assert.equal(editionGroupKey(null), "");
  assert.equal(editionGroupKey(""), "");
  assert.equal(identityName("Final Fantasy VII"), identityName("final fantasy 7"));
  assert.equal(metadataMatchesStorefront("Elden Ring", "ELDEN RING™"), true);
  assert.equal(metadataMatchesStorefront("Elden Ring", "Elden Ring Nightreign"), false);
  assert.equal(metadataMatchesStorefront(null, "x"), true);
});
