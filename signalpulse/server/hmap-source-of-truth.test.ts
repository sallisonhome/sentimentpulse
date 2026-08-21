// Unit tests for hmap-source-of-truth.
// Run via: npm test  (see package.json).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchHmapWishlistRanks,
  resolveManualRanks,
} from "./hmap-source-of-truth";

// ------- fetchHmapWishlistRanks (with injected fetchImpl) -------

test("fetchHmapWishlistRanks: parses a valid response into a rank map", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        generated_at: "2026-08-21T13:25:03.036Z",
        data: [
          { appid: 1551980, rank: 157, name: "Hellraiser" },
          { appid: 999, rank: 12, name: "Something Else" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const res = await fetchHmapWishlistRanks(fakeFetch);
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rankByAppid.get(1551980), 157);
  assert.equal(res.rankByAppid.get(999), 12);
  assert.equal(res.generatedAt, "2026-08-21T13:25:03.036Z");
});

test("fetchHmapWishlistRanks: non-2xx \u2192 ok=false, no rows", async () => {
  const fakeFetch = (async () =>
    new Response("Bad Gateway", { status: 502 })) as unknown as typeof fetch;
  const res = await fetchHmapWishlistRanks(fakeFetch);
  assert.equal(res.ok, false);
  assert.equal(res.rows.length, 0);
  assert.equal(res.error, "HTTP 502");
});

test("fetchHmapWishlistRanks: malformed shape \u2192 ok=false", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ hello: "world" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const res = await fetchHmapWishlistRanks(fakeFetch);
  assert.equal(res.ok, false);
  assert.equal(res.error, "unexpected response shape (missing data[])");
});

test("fetchHmapWishlistRanks: bad rows are skipped, valid rows kept", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { appid: 100, rank: 5, name: "OK" },
          { appid: -1, rank: 7 }, // invalid appid
          { appid: 200, rank: 0 }, // invalid rank
          { appid: 300, rank: 9, name: "Also OK" },
          "not an object",
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const res = await fetchHmapWishlistRanks(fakeFetch);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 2);
  assert.deepEqual(
    res.rows.map((r) => r.appid).sort((a, b) => a - b),
    [100, 300],
  );
});

test("fetchHmapWishlistRanks: fetch throws \u2192 ok=false, error captured", async () => {
  const fakeFetch = (async () => {
    throw new Error("network unreachable");
  }) as unknown as typeof fetch;
  const res = await fetchHmapWishlistRanks(fakeFetch);
  assert.equal(res.ok, false);
  assert.equal(res.error, "network unreachable");
});

// ------- resolveManualRanks (pure) -------

test("resolveManualRanks: hmap wins when available; Steam-native handled upstream", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map([[1551980, 157]]),
    hmapOk: true,
    manualAppids: [1551980],
    steamAppidSet: new Set(), // Steam omitted \u2014 fallback path
    lastKnownRanks: new Map([
      [1551980, { rank: 155, captured_at: new Date().toISOString() }],
    ]),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.get(1551980), 157);
  assert.equal(result.metrics.hmap_source_count, 1);
  assert.equal(result.metrics.last_known_source_count, 0);
  assert.equal(result.metrics.seed_source_count, 0);
  // Delta logging: hmap says 157, local last-known was 155 \u2192 +2 drift.
  assert.equal(result.metrics.delta_nonzero_count, 1);
  const entry = result.metrics.entries[0];
  assert.equal(entry.source, "hmap");
  assert.equal(entry.hmap_rank, 157);
  assert.equal(entry.local_rank, 155);
  assert.equal(entry.delta, 2);
});

test("resolveManualRanks: hmap down \u2192 last-known used", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map(),
    hmapOk: false,
    manualAppids: [1551980],
    steamAppidSet: new Set(),
    lastKnownRanks: new Map([
      [1551980, { rank: 148, captured_at: new Date().toISOString() }],
    ]),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.get(1551980), 148);
  assert.equal(result.metrics.hmap_source_count, 0);
  assert.equal(result.metrics.last_known_source_count, 1);
  assert.equal(result.metrics.entries[0].source, "last_known");
});

test("resolveManualRanks: hmap down + no last-known \u2192 seed used", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map(),
    hmapOk: false,
    manualAppids: [1551980],
    steamAppidSet: new Set(),
    lastKnownRanks: new Map(),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.get(1551980), 155);
  assert.equal(result.metrics.seed_source_count, 1);
  assert.equal(result.metrics.entries[0].source, "seed_rank");
});

test("resolveManualRanks: hmap down + no last-known + no seed \u2192 no override", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map(),
    hmapOk: false,
    manualAppids: [42],
    steamAppidSet: new Set(),
    lastKnownRanks: new Map(),
    seedRankByAppid: new Map([[42, null]]),
  });
  assert.equal(result.rankOverrides.size, 0);
  assert.equal(result.metrics.none_source_count, 1);
  assert.equal(result.metrics.entries[0].source, "none");
});

test("resolveManualRanks: Steam returned the appid \u2192 skipped entirely", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map([[1551980, 157]]),
    hmapOk: true,
    manualAppids: [1551980],
    steamAppidSet: new Set([1551980]), // Steam did return it
    lastKnownRanks: new Map(),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.size, 0);
  assert.equal(result.metrics.entries.length, 0);
  assert.equal(result.metrics.hmap_source_count, 0);
});

test("resolveManualRanks: hmap missing an appid we manage \u2192 falls through to last-known", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map([[999, 5]]), // hmap doesn't cover 1551980
    hmapOk: true,
    manualAppids: [1551980],
    steamAppidSet: new Set(),
    lastKnownRanks: new Map([
      [1551980, { rank: 148, captured_at: new Date().toISOString() }],
    ]),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.get(1551980), 148);
  assert.equal(result.metrics.last_known_source_count, 1);
  assert.equal(result.metrics.hmap_covered, 0);
});

test("resolveManualRanks: hmap and local last-known agree \u2192 no drift counted", () => {
  const result = resolveManualRanks({
    hmapRankByAppid: new Map([[1551980, 157]]),
    hmapOk: true,
    manualAppids: [1551980],
    steamAppidSet: new Set(),
    lastKnownRanks: new Map([
      [1551980, { rank: 157, captured_at: new Date().toISOString() }],
    ]),
    seedRankByAppid: new Map([[1551980, 155]]),
  });
  assert.equal(result.rankOverrides.get(1551980), 157);
  assert.equal(result.metrics.delta_nonzero_count, 0);
  assert.equal(result.metrics.entries[0].delta, 0);
});
