// Unit tests for wishlist-manual-merge. Run via:
//   npx tsx --test server/wishlist-manual-merge.test.ts
//
// These exercise the pure functions only (mergeIntoRankMap, detectDrops)
// and the JSON loader against the shipped data file. No DB, no network.
// SignalPulse has no test framework in package.json today; using
// node:test keeps zero new devDependencies while still giving us a
// runnable regression net for the merge logic.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadManualAppids,
  mergeIntoRankMap,
  detectDrops,
} from "./wishlist-manual-merge";

test("loadManualAppids parses the shipped JSON and includes Hellraiser (1551980)", async () => {
  const entries = await loadManualAppids();
  const hell = entries.find((e) => e.appid === 1551980);
  assert.ok(hell, "Hellraiser entry (appid 1551980) must be present in the shipped JSON");
  assert.equal(hell.name, "Clive Barker's Hellraiser: Revival");
  assert.equal(hell.seed_rank, 155);
  assert.ok(hell.logo?.includes("1551980/header.jpg"), "logo must use the header.jpg convention");
});

test("mergeIntoRankMap: Steam returned the appid \u2192 recovered, no override", () => {
  const result = mergeIntoRankMap({
    manualEntries: [
      { appid: 1551980, name: "Hellraiser", seed_rank: 155, logo: null },
    ],
    lastKnownRanks: new Map(),
    steamAppidSet: new Set([1551980, 999]),
  });
  assert.equal(result.rankOverrides.size, 0);
  assert.equal(result.metrics.manual_inserts_active, 0);
  assert.equal(result.metrics.manual_inserts_recovered, 1);
  assert.deepEqual(result.metrics.manual_recovered_appids, [1551980]);
});

test("mergeIntoRankMap: Steam omitted + we have last-known \u2192 last_known wins", () => {
  const result = mergeIntoRankMap({
    manualEntries: [
      { appid: 1551980, name: "Hellraiser", seed_rank: 155, logo: null },
    ],
    lastKnownRanks: new Map([
      [1551980, { rank: 148, captured_at: new Date().toISOString() }],
    ]),
    steamAppidSet: new Set([999]),
  });
  assert.equal(result.rankOverrides.get(1551980), 148);
  assert.equal(result.metrics.manual_inserts_active, 1);
  assert.equal(result.metrics.manual_inserts_stale, 0);
  const detail = result.metrics.inserts_detail[0];
  assert.equal(detail.source, "last_known");
  assert.equal(detail.fallback_rank, 148);
});

test("mergeIntoRankMap: Steam omitted + no last-known \u2192 seed_rank used", () => {
  const result = mergeIntoRankMap({
    manualEntries: [
      { appid: 1551980, name: "Hellraiser", seed_rank: 155, logo: null },
    ],
    lastKnownRanks: new Map(),
    steamAppidSet: new Set([999]),
  });
  assert.equal(result.rankOverrides.get(1551980), 155);
  assert.equal(result.metrics.inserts_detail[0].source, "seed_rank");
});

test("mergeIntoRankMap: Steam omitted + no last-known + no seed_rank \u2192 no override, source=none", () => {
  const result = mergeIntoRankMap({
    manualEntries: [
      { appid: 42, name: "Some Title", seed_rank: null, logo: null },
    ],
    lastKnownRanks: new Map(),
    steamAppidSet: new Set([]),
  });
  assert.equal(result.rankOverrides.size, 0);
  assert.equal(result.metrics.manual_inserts_active, 0);
  assert.equal(result.metrics.inserts_detail[0].source, "none");
});

test("mergeIntoRankMap: stale detection fires when last-known is older than staleWarningDays", () => {
  const oldDate = new Date();
  oldDate.setUTCDate(oldDate.getUTCDate() - 45);
  const result = mergeIntoRankMap({
    manualEntries: [
      { appid: 1551980, name: "Hellraiser", seed_rank: 155, logo: null },
    ],
    lastKnownRanks: new Map([
      [1551980, { rank: 148, captured_at: oldDate.toISOString() }],
    ]),
    steamAppidSet: new Set(),
    staleWarningDays: 30,
  });
  assert.equal(result.metrics.manual_inserts_stale, 1);
  // Still uses last-known; stale is a warning signal, not a disqualifier.
  assert.equal(result.rankOverrides.get(1551980), 148);
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
