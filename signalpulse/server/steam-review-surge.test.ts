import test from "node:test";
import assert from "node:assert/strict";
import { detectReviewSurge, DayBucket } from "./steam-review-surge";

const D = 86400, t0 = Date.parse("2026-09-04T00:00:00Z") / 1000;
const mk = (rows: Array<[number, number]>, startOffsetDays = 0): DayBucket[] =>
  rows.map(([up, down], i) => ({ start: t0 + (startOffsetDays + i) * D, up, down }));
const flat = (n: number, up = 115, down = 5) => Array.from({ length: n }, () => [up, down] as [number, number]);
// 9/4..9/25 baseline (22 days) + live Witcher 3 remaster days 9/26..10/2
const witcher = mk([...flat(22), [162, 5], [216, 6], [438, 15], [2442, 1133], [1363, 763], [1111, 386], [715, 223]]);

test("live Witcher 3 remaster week is flagged and scaled to baseline", () => {
  const r = detectReviewSurge(witcher, "2026-10-02", 7);
  assert.equal(r.flagged, true);
  assert.ok(r.ratio! > 5); assert.ok(r.scale! < 0.2 && r.scale! > 0.05);
});
test("a sale bump with a normal negative share is not flagged", () => {
  const sale = mk([...flat(22), [300, 10], [400, 12], [500, 15], [600, 20], [600, 20], [550, 18], [500, 15]]);
  const r = detectReviewSurge(sale, "2026-10-02", 7);
  assert.equal(r.flagged, false); assert.equal(r.reason, "surge_without_negative_jump");
});
test("a quiet title is not flagged", () => {
  assert.equal(detectReviewSurge(mk(flat(29)), "2026-10-02", 7).reason, "below_volume");
});
test("a small title with a surge below the volume floor is not flagged", () => {
  const small = mk([...flat(22, 8, 1), ...flat(7, 40, 30)]);
  assert.equal(detectReviewSurge(small, "2026-10-02", 7).flagged, false);
});
test("missing days in the window or too little baseline are unknown, not flagged", () => {
  assert.equal(detectReviewSurge(witcher.filter((_, i) => i !== 25), "2026-10-02", 7).reason, "incomplete_window");
  assert.equal(detectReviewSurge(witcher.slice(12), "2026-10-02", 7).reason, "insufficient_baseline");
});
test("invalid history and bad input are never flagged", () => {
  assert.equal(detectReviewSurge([{ start: t0, up: -1, down: 0 }], "2026-10-02", 7).flagged, false);
  assert.equal(detectReviewSurge(witcher, "not-a-date", 7).flagged, false);
});
test("a new launch (no pre-window baseline) is not flagged", () => {
  const launch = mk([...flat(7, 3000, 150)], 22);
  assert.equal(detectReviewSurge(launch, "2026-10-02", 7).flagged, false);
});
test("a 30-day window containing the surge is caught and only surge days are replaced", () => {
  const full = mk([...flat(52), [162, 5], [216, 6], [438, 15], [2442, 1133], [1363, 763], [1111, 386], [715, 223]], -30);
  const r = detectReviewSurge(full, "2026-10-02", 30);
  assert.equal(r.flagged, true);
  // ordinary days stay as observed; the 5 surge days are replaced by the baseline (about 3.6K of 11.3K reviews remain)
  assert.ok(r.scale! > 0.25 && r.scale! < 0.4, String(r.scale));
});
test("the 7-day scale keeps ordinary days and replaces only surge days", () => {
  const r = detectReviewSurge(witcher, "2026-10-02", 7);
  assert.ok(r.scale! < 0.2);
});
