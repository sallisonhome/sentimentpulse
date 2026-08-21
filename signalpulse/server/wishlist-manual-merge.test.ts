// Unit tests for wishlist-manual-merge (allowlist + drop detector).
// Run via: npm test  (see package.json).
//
// These exercise pure functions only \u2014 no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadManualAppids, detectDrops } from "./wishlist-manual-merge";

test("loadManualAppids: parses shipped JSON and includes Hellraiser (1551980)", async () => {
  const entries = await loadManualAppids();
  const hell = entries.find((e) => e.appid === 1551980);
  assert.ok(hell, "Hellraiser entry (appid 1551980) must be present");
  assert.equal(hell.name, "Clive Barker's Hellraiser: Revival");
  // seed_rank stays at 155 intentionally so hmap wins on the first sync
  // (hmap observed 157 on 2026-08-21). This is documented in the JSON.
  assert.equal(hell.seed_rank, 155);
  assert.ok(hell.logo?.includes("1551980/header.jpg"));
});

test("detectDrops: recently ranked + missing today + not manual-covered \u2192 drop", () => {
  const drops = detectDrops({
    trackedAppids: [111, 222, 333],
    steamAppidSet: new Set([111]),
    manualCoveredAppids: new Set([222]),
    rankedDaysInWindow: new Map([
      [111, 14],
      [222, 14],
      [333, 5],
    ]),
    minRankedDaysForDrop: 1,
  });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].appid, 333);
  assert.equal(drops[0].ranked_days_in_window, 5);
});

test("detectDrops: appid never ranked in window \u2192 not a drop", () => {
  const drops = detectDrops({
    trackedAppids: [333],
    steamAppidSet: new Set(),
    manualCoveredAppids: new Set(),
    rankedDaysInWindow: new Map([[333, 0]]),
    minRankedDaysForDrop: 1,
  });
  assert.equal(drops.length, 0);
});

test("detectDrops: manual-covered appid never reported as drop even if missing", () => {
  const drops = detectDrops({
    trackedAppids: [1551980],
    steamAppidSet: new Set(),
    manualCoveredAppids: new Set([1551980]),
    rankedDaysInWindow: new Map([[1551980, 10]]),
    minRankedDaysForDrop: 1,
  });
  assert.equal(drops.length, 0);
});
