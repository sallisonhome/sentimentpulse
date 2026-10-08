import test from "node:test";
import assert from "node:assert/strict";
import { applyPs5EnglishNames, hasCjk, parsePsStoreTitle, resolvePs5EnglishName } from "./ps5-english-name";
import { editionGroupKey } from "../../console-sales-family";

const JA = "真・三國無双２ with 猛将伝 Remastered";
const EN = "DYNASTY WARRIORS 3: Complete Edition Remastered";

test("detects Japanese, Chinese and Korean names and ignores Latin ones", () => {
  assert.ok(hasCjk(JA)); assert.ok(hasCjk("원신")); assert.ok(!hasCjk(EN)); assert.ok(!hasCjk("Pokémon™ Legends"));
});
test("page title parser: English only, strips store suffix, decodes entities", () => {
  assert.equal(parsePsStoreTitle(`<html><title>${EN}</title>`), EN);
  assert.equal(parsePsStoreTitle("<title>Tom &amp; Jerry | PlayStation Store</title>"), "Tom & Jerry");
  assert.equal(parsePsStoreTitle(`<title>${JA}</title>`), null);
  assert.equal(parsePsStoreTitle("<p>none</p>"), null);
});
test("reviewed SKU names win and never hit the network", async () => {
  const f = async () => { throw new Error("no network expected"); };
  assert.equal(await resolvePs5EnglishName("JP0106-PPSA32935_00-DW3CEREMASTERED0", JA, f), EN);
});
test("unreviewed CJK name falls back to the store page title, then to the grid name", async () => {
  assert.equal(await resolvePs5EnglishName("X1", JA, async () => "<title>Some English Game</title>"), "Some English Game");
  assert.equal(await resolvePs5EnglishName("X2", JA, async () => { throw new Error("HTTP 500"); }), JA);
  assert.equal(await resolvePs5EnglishName("X3", JA, async () => `<title>${JA}</title>`), JA);
});
test("Latin names are never refetched or changed", async () => {
  let calls = 0;
  const rows = [{ productId: "P", name: "Elden Ring", editions: [{ productId: "E", name: "Elden Ring Deluxe" }] }];
  assert.equal(await applyPs5EnglishNames(rows, () => {}, async () => { calls++; return ""; }), 0);
  assert.equal(calls, 0); assert.equal(rows[0].name, "Elden Ring");
});
test("base and edition rows are both repaired, and the PS5 family key then equals Steam and Xbox", async () => {
  const rows = [{ productId: "JP0106-PPSA32935_00-DW3CEREMASTERED0", name: JA, editions: [{ productId: "JP0106-PPSA32935_00-DW3CEREDDXE00000", name: `${JA} Digital Deluxe Edition` }] }];
  assert.equal(editionGroupKey(rows[0].name) === editionGroupKey(EN), false, "before the fix the keys differ");
  assert.equal(await applyPs5EnglishNames(rows, () => {}), 2);
  assert.equal(rows[0].name, EN);
  assert.equal(editionGroupKey(rows[0].name!), editionGroupKey(EN));
  assert.equal(editionGroupKey(rows[0].editions![0].name!), editionGroupKey(EN), "Deluxe collapses into the same family");
});
