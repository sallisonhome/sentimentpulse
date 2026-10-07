import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadToAnchors, shapeCredible, interpolateShape } from "./anchored-daily-spread";

const days = (n: number, start = "2026-09-26") => Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
const mk = (ds: string[], steam: Array<number | null>, xbox: Array<number | null>) =>
  ds.map((d, i) => ({ date: d, steam: steam[i], ps5: null, xbox: xbox[i], combined: null } as Record<string, any>));
const sum = (pts: any[], pl: string, upTo = "9999") => pts.reduce((a, p) => (typeof p[pl] === "number" && p.date <= upTo ? a + p[pl] : a), 0);

test("whole-life: days up to the anchor add up to it, all days add up to lifetime, growth keeps the shape", () => {
  const ds = days(10), pts = mk(ds, [100, 90, 80, 70, 60, 50, 50, 40, 40, 30], Array(10).fill(null));
  const rec = spreadToAnchors(pts, { steam: { anchorUsd: 1000, anchorAsOf: ds[6], wholeLife: true, estimatorAtAnchorUsd: null } });
  assert.ok(Math.abs(sum(pts, "steam", ds[6]) - 1000) < 1e-6);
  assert.ok(Math.abs(sum(pts, "steam") - rec.steam!.lifetimeUsd) < 1e-6);
  assert.ok(rec.steam!.lifetimeUsd > 1000 && Math.abs(rec.steam!.beforeSeriesUsd) < 1e-6);
  assert.ok(Math.abs(rec.steam!.growthUsd - 220) < 1e-9, "k = 1000/500 = 2 applied to the 110 of shape after the anchor");
});

test("zero rows from a platform with no estimates take Steam's shape; every day is valued and they add up", () => {
  const ds = days(10), steam = [100, 90, 80, 70, 60, 50, 50, 40, 40, 30];
  const xbox = [0, 0, 0, 0, 0, 0, 0, 5, 0, 700];                       // zeros then a catch-up spike
  const pts = mk(ds, steam, xbox);
  const rec = spreadToAnchors(pts, { xbox: { anchorUsd: 2000, anchorAsOf: ds[9], wholeLife: true, estimatorAtAnchorUsd: null } });
  assert.equal(rec.xbox!.shape, "steam");
  assert.ok(pts.every(p => typeof p.xbox === "number" && p.xbox > 0), "no zero or empty rows");
  assert.ok(Math.abs(sum(pts, "xbox") - 2000) < 1e-6);
  assert.equal(pts[0].allocation.xbox, "anchor_spread:steam_shape");
});

test("a credible own shape is kept; empty and zero days inside it are interpolated and marked", () => {
  const ds = days(10), pts = mk(ds, [10, 12, null, 0, 14, 13, 12, 11, 10, 9], Array(10).fill(null));
  const rec = spreadToAnchors(pts, { steam: { anchorUsd: 500, anchorAsOf: ds[9], wholeLife: true, estimatorAtAnchorUsd: null } });
  assert.equal(rec.steam!.shape, "own");
  assert.equal(rec.steam!.interpolatedDays, 2);
  assert.equal(pts[2].allocation.steam, "anchor_spread:interpolated");
  assert.ok(Math.abs(sum(pts, "steam") - 500) < 1e-6);
});

test("older title: lifetime = anchor + growth at the estimator calibration; pre-series part is reported, not placed on a day", () => {
  const ds = days(6, "2026-10-01"), pts = mk(ds, [10, 10, 10, 10, 10, 10], Array(6).fill(null));
  // estimator lifetime at the anchor date is 100 for an anchor of 1000: k = 10; 3 days after the anchor
  const rec = spreadToAnchors(pts, { steam: { anchorUsd: 1000, anchorAsOf: ds[2], wholeLife: false, estimatorAtAnchorUsd: 100 } });
  assert.ok(Math.abs(rec.steam!.growthUsd - 300) < 1e-9 && Math.abs(rec.steam!.lifetimeUsd - 1300) < 1e-9);
  assert.ok(Math.abs(rec.steam!.daysSumUsd + rec.steam!.beforeSeriesUsd - 1300) < 1e-9);
});

test("credibility and interpolation helpers", () => {
  assert.equal(shapeCredible([0, 0, 0, 0, 0, 5]), false);
  assert.equal(shapeCredible([5, 5, 5, 5, 5]), true);
  assert.equal(shapeCredible([1, 1, 1, 1, 100]), false, "one day dominates");
  assert.deepEqual(interpolateShape([2, null, 4]).shape, [2, 3, 4]);
});
