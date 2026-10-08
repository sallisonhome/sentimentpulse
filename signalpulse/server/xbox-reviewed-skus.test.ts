import test from "node:test";
import assert from "node:assert/strict";
import { REVIEWED_XBOX_FAMILIES, planReviewedFamily, storeNameMatchesFamily } from "./xbox-reviewed-skus";

const fam = REVIEWED_XBOX_FAMILIES.find(f => f.family === "Minecraft Dungeons II")!;
const names = { "9P5786PJB9RP": "Minecraft Dungeons II", "9NFDXGJ16M47": "Minecraft Dungeons II Deluxe Edition" };

test("base and deluxe both plan as inserts at the PS5 prices (live store names)", () => {
  const p = planReviewedFamily(fam, names, new Set());
  assert.deepEqual(p.map(x => [x.bigId, x.role, x.msrpUsdCents, x.action]),
    [["9P5786PJB9RP", "base", 2999, "insert"], ["9NFDXGJ16M47", "edition", 4999, "insert"]]);
});
test("existing rows are not re-inserted", () => {
  assert.deepEqual(planReviewedFamily(fam, names, new Set(["9P5786PJB9RP"])).map(x => x.action), ["exists", "insert"]);
});
test("a store name for another game is rejected", () => {
  assert.equal(storeNameMatchesFamily("Minecraft Dungeons", "Minecraft Dungeons II"), false);
  assert.equal(storeNameMatchesFamily("Minecraft Dungeons for Windows + Launcher", "Minecraft Dungeons II"), false);
  const p = planReviewedFamily(fam, { ...names, "9NFDXGJ16M47": "Minecraft" }, new Set());
  assert.equal(p[1].reason, "store_name_mismatch");
});
test("missing store name or missing price is rejected", () => {
  assert.equal(planReviewedFamily(fam, {}, new Set())[0].action, "reject");
  assert.equal(planReviewedFamily({ ...fam, skus: [{ ...fam.skus[0], msrpUsdCents: 0 }] }, names, new Set())[0].reason, "no_price");
});
test("a family needs exactly one base", () => {
  assert.equal(planReviewedFamily({ ...fam, skus: [fam.skus[1]] }, names, new Set())[0].reason, "need_exactly_one_base");
});
test("the list matches the family the PS5 rows use", () => {
  assert.equal(fam.family, "Minecraft Dungeons II");
  assert.deepEqual(fam.skus.map(s => s.msrpUsdCents), [2999, 4999]);
});

test("Hellraiser: Revival plans base and Deluxe at the PS5 prices, curly apostrophes match", () => {
  const h = REVIEWED_XBOX_FAMILIES.find(f => f.family === "Clive Barker's Hellraiser: Revival")!;
  const n = { "9PN93T01JMSR": "Clive Barker\u2019s Hellraiser: Revival", "9N3TVB2GX7CT": "Clive Barker\u2019s Hellraiser: Revival - Deluxe Edition" };
  assert.deepEqual(planReviewedFamily(h, n, new Set()).map(x => [x.bigId, x.role, x.msrpUsdCents, x.action]),
    [["9PN93T01JMSR", "base", 3999, "insert"], ["9N3TVB2GX7CT", "edition", 4999, "insert"]]);
  assert.equal(planReviewedFamily(h, { ...n, "9N3TVB2GX7CT": "Hellraiser" }, new Set())[1].reason, "store_name_mismatch");
});
