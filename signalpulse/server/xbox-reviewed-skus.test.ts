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
  const n = { "9NSWRGZBQ2MC": "Clive Barker\u2019s Hellraiser: Revival", "9N3TVB2GX7CT": "Clive Barker\u2019s Hellraiser: Revival - Deluxe Edition" };
  assert.deepEqual(planReviewedFamily(h, n, new Set()).map(x => [x.bigId, x.role, x.msrpUsdCents, x.action]),
    [["9NSWRGZBQ2MC", "base", 3999, "insert"], ["9N3TVB2GX7CT", "edition", 4999, "insert"]]);
  assert.equal(planReviewedFamily(h, { ...n, "9N3TVB2GX7CT": "Hellraiser" }, new Set())[1].reason, "store_name_mismatch");
});

test("Elden Ring plans the paid SKU at the PS5 price and pins to the existing Xbox title", () => {
  const e = REVIEWED_XBOX_FAMILIES.find(f => f.family === "ELDEN RING")!;
  assert.equal(e.attachToTitleId, 11066);
  assert.deepEqual(planReviewedFamily(e, { "9P3J32CTXLRZ": "ELDEN RING" }, new Set()).map(x => [x.bigId, x.role, x.msrpUsdCents, x.action]),
    [["9P3J32CTXLRZ", "base", 5999, "insert"]]);
  // Store-name variants of the same game: ™ noise is stripped, case is ignored,
  // and the existing prefix rule accepts a trailing edition label (by design for
  // "Family Deluxe Edition" listings) — so NIGHTREIGN passes it too. A name
  // outside the family prefix is rejected. The seed's dry run prints the live
  // store name for the bigId, which is the stronger check before any write.
  assert.equal(storeNameMatchesFamily("ELDEN RING™", "ELDEN RING"), true);
  assert.equal(storeNameMatchesFamily("Elden Ring", "ELDEN RING"), true);
  assert.equal(storeNameMatchesFamily("Hellraiser", "ELDEN RING"), false);
  assert.equal(planReviewedFamily(e, { "9P3J32CTXLRZ": "Hellraiser" }, new Set())[0].reason, "store_name_mismatch");
});

test("Star Wars: Galactic Racer plans the paid SKU at the PS5 price as a new family", () => {
  const g = REVIEWED_XBOX_FAMILIES.find(f => f.family === "STAR WARS: Galactic Racer")!;
  assert.equal(g.attachToTitleId, undefined);
  assert.deepEqual(planReviewedFamily(g, { "9MXDPXSRVML5": "STAR WARS: Galactic Racer\u2122" }, new Set()).map(x => [x.bigId, x.role, x.msrpUsdCents, x.action]),
    [["9MXDPXSRVML5", "base", 5999, "insert"]]);
  // A colon-less store title would be a different name — reject, never guess.
  assert.equal(planReviewedFamily(g, { "9MXDPXSRVML5": "Star Wars Galactic Racer" }, new Set())[0].reason, "store_name_mismatch");
});
