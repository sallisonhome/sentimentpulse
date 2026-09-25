import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewWindow, utcWindowBounds, type ReviewBucket } from "./steam-review-windows";
const sec = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const bucket = (date: string, grain: string, count: number): ReviewBucket => ({
  bucket_start: sec(date), bucket_granularity: grain, recommendations_up: count, recommendations_down: 0,
});
const days = (start: string, n: number, count = 10) => Array.from({ length: n }, (_, i) => ({
  ...bucket(start, "day", count), bucket_start: sec(start) + i * 86400,
}));
test("Zero Company-shaped daily+weekly history counts once in every window", () => {
  const daily = days("2026-08-27", 29);
  const weekly = [0,7,14,21,28].map(i => ({
    ...bucket("2026-08-27", "week", Math.min(7, 29-i)*10), bucket_start: sec("2026-08-27")+i*86400,
  }));
  for (const [window, expected] of [[7,70],[30,290],[90,290],[365,290],[null,290]] as const) {
    const r = reviewWindow(daily.concat(weekly), "2026-09-24", window, "week");
    assert.equal(r.signal, expected); assert.ok(r.discardedOverlaps > 0); assert.equal(r.coarseBoundary, false);
  }
});
test("mixed monthly/weekly histories select only current grain", () => {
  const rows = [bucket("2026-08-01","month",310),bucket("2026-09-01","month",240),
    bucket("2026-09-01","week",700),...days("2026-09-01",24)];
  assert.equal(reviewWindow(rows,"2026-09-24",null,"month").signal,550);
  assert.equal(reviewWindow(rows,"2026-09-24",7,"month").signal,70);
});
test("partial daily coverage cannot be added on top of a retained coarse bucket", () => {
  const r=reviewWindow([bucket("2026-09-01","week",70),...days("2026-09-05",10)],"2026-09-14",30,"week");
  assert.equal(r.signal,140); assert.equal(r.coarseBoundary,true);
});
test("coarse historical boundaries do not manufacture fractional reviews", () => {
  const rows=[bucket("2026-08-01","month",310),bucket("2026-09-01","month",240),...days("2026-09-01",24)];
  const r=reviewWindow(rows,"2026-09-24",30,"month");
  assert.equal(r.signal,240); assert.equal(r.coarseBoundary,true);
});
test("UTC boundaries include exactly seven dates, exclude future input", () => {
  const rows=days("2026-09-17",9);
  assert.equal(reviewWindow(rows,"2026-09-24",7).signal,70);
  assert.deepEqual(utcWindowBounds("2026-09-24",7),{start:sec("2026-09-18"),end:sec("2026-09-25")});
  assert.throws(()=>utcWindowBounds("2026-02-30",7));
});
test("zero observations differ from absent/corrupt history", () => {
  assert.equal(reviewWindow([],"2026-09-24",7).signal,null);
  assert.equal(reviewWindow([bucket("2026-09-24","day",0)],"2026-09-24",7).signal,0);
  assert.equal(reviewWindow([bucket("2026-09-24","day",-1)],"2026-09-24",7).signal,null);
  assert.equal(reviewWindow([bucket("2026-09-24","day",1),bucket("2026-09-24","day",2)],"2026-09-24",7).signal,null);
});
test("duplicate identical rows, reversed input and leap-month boundaries are stable", () => {
  const rows=[bucket("2024-02-01","month",290),...days("2024-02-01",29),bucket("2024-03-01","day",10)];
  const r=reviewWindow(rows,"2024-03-01",null,"month");
  assert.equal(r.signal,300);
  assert.equal(reviewWindow(rows.concat(rows).reverse(),"2024-03-01",null,"month").signal,300);
});
