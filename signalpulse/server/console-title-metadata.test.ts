import { test } from "node:test";
import assert from "node:assert/strict";
import { safeTitleMetadata } from "./console-title-metadata";
const halloween = {
  name: "Solitaire Game Halloween 2", storeName: "Halloween: The Game",
  coverUrl: "wrong-cover", storeHeaderImageUrl: "store-cover",
  releaseDate: "2021-05-16", storeReleaseDate: "2026-09-08",
  summary: "Wrong game", artworkUrl: "wrong-art", matchConfidence: "low",
  screenshotsJson: '["wrong-shot"]', developersJson: '["Creobit"]',
  publishersJson: '["8FLOOR"]', platformsJson: '["PC"]', igdbId: 148091, slug: "wrong-game",
};
test("Halloween rejects all mismatched enrichment and uses storefront identity", () => {
  const m = safeTitleMetadata(halloween)!;
  assert.equal(m.name, "Halloween: The Game");
  assert.equal(m.coverUrl, "store-cover");
  assert.equal(m.releaseDate, "2026-09-08");
  for (const key of ["summary","artworkUrl","igdbId","slug","screenshotsJson"]) assert.equal(m[key],null);
  for (const key of ["screenshots","developers","publishers","platforms"]) assert.deepEqual(m[key],[]);
});
test("missing storefront fields never fall back to a known-wrong game", () => {
  const m = safeTitleMetadata({...halloween, storeName:null,storeHeaderImageUrl:null,storeReleaseDate:null})!;
  assert.equal(m.name,null); assert.equal(m.coverUrl,null); assert.equal(m.releaseDate,null);
});
test("family mismatch is rejected even if confidence flag is stale", () => {
  assert.equal(safeTitleMetadata({...halloween,matchConfidence:"high"},true)!.name,"Halloween: The Game");
});
test("valid enrichment remains intact and malformed JSON does not crash PDP", () => {
  const m = safeTitleMetadata({...halloween,matchConfidence:"high",screenshotsJson:"broken"})!;
  assert.equal(m.name,halloween.name); assert.deepEqual(m.screenshots,[]);
  assert.deepEqual(m.developers,["Creobit"]);
  assert.equal(safeTitleMetadata(undefined),null);
});
