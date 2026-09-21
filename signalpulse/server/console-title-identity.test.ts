import { test } from "node:test";
import assert from "node:assert/strict";
import { metadataMatchesStorefront, uniquePlatformTitles } from "./console-title-identity";

test("base-game metadata must not resolve to updates, DLC, sequels or spin-offs", () => {
  for (const title of [
    "No Man's Sky: Worlds Part II", "No Man's Sky: Worlds Part I",
    "No Man's Sky Beyond", "No Man's Sky: NEXT", "No Man's Sky 2",
  ]) assert.equal(metadataMatchesStorefront("No Man's Sky", title), false, title);
  assert.equal(metadataMatchesStorefront("Elden Ring", "Elden Ring Nightreign"), false);
  assert.equal(metadataMatchesStorefront("Halloween: The Game", "Solitaire Game Halloween 2"), false);
});

test("platform tags, punctuation and edition packaging do not split the base game", () => {
  for (const title of [
    "No Man’s Sky", "No Man's Sky PS4 & PS5", "No Man's Sky (PS5)",
    "No Man's Sky Digital Deluxe Edition", "No Man's Sky (Xbox Series X|S)",
  ]) assert.equal(metadataMatchesStorefront(title, "No Man's Sky"), true, title);
  assert.equal(metadataMatchesStorefront(null, "A game"), true);
  assert.equal(metadataMatchesStorefront("Baldur's Gate 3", "Baldur's Gate III"), true);
  assert.equal(metadataMatchesStorefront("Warhammer 40,000: Space Marine 2", "Warhammer 40,000: Space Marine II"), true);
  assert.equal(metadataMatchesStorefront("METAL GEAR SOLID Δ: SNAKE EATER", "Metal Gear Solid Delta: Snake Eater"), true);
  assert.equal(metadataMatchesStorefront("The Planet Crafter", "Planet Crafter"), true);
  assert.equal(metadataMatchesStorefront("Nioh Remastered – The Complete Edition", "Nioh Remastered: Complete Edition"), true);
});

test("regional duplicates count once and retain the available price regardless of input order", () => {
  const eu = { titleId: 10350, platform: "ps5", msrpUsdCents: null };
  const us = { ...eu, msrpUsdCents: 5999 };
  const steam = { titleId: 10005, platform: "steam", msrpUsdCents: 5999 };
  for (const rows of [[eu, us, steam], [us, eu, steam]]) {
    assert.deepEqual(uniquePlatformTitles(rows), [us, steam]);
  }
});
