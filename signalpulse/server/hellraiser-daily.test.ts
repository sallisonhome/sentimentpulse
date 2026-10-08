import test from "node:test";
import assert from "node:assert/strict";
import { steamDailyActual, consoleDailyUnits } from "./hellraiser-daily";

const R = "2026-10-08";
test("Steam D1 is every pre-release day plus release-day sales, then actual days", () => {
  const rows = [{ date: "2026-09-30", units: 10, revenue: 400 }, { date: "2026-10-07", units: 20, revenue: 800 }, { date: "2026-10-08", units: 100, revenue: 4000 }, { date: "2026-10-09", units: 50, revenue: 2000 }];
  const s = steamDailyActual(rows, R);
  assert.deepEqual(s.days.get(R), { revenue: 5200, units: 130 });
  assert.equal(s.days.get("2026-10-07"), undefined);
  assert.equal(s.days.get("2026-10-09")!.revenue, 2000);
  assert.equal(s.days.get("2026-10-10"), undefined);
});
test("Steam D1 is prepurchase only and flagged partial until the release-day row exists", () => {
  const s = steamDailyActual([{ date: "2026-10-06", units: 10, revenue: 400 }, { date: "2026-10-07", units: 20, revenue: 800 }], R);
  assert.deepEqual(s.days.get(R), { revenue: 1200, units: 30, partial: true });
});
test("no pre-release rows means no series", () => {
  assert.equal(steamDailyActual([{ date: "2026-10-09", units: 5, revenue: 100 }], R).days.size, 0);
});
test("console: first estimate on D1 is prepurchase plus day 1; later days are daily deltas", () => {
  const u = consoleDailyUnits([{ date: "2026-10-07", units: 0 }, { date: R, units: 1000 }, { date: "2026-10-09", units: 1300 }], new Map(), R);
  assert.equal(u.get(R), 1000); assert.equal(u.get("2026-10-09"), 300); assert.equal(u.get("2026-10-07"), undefined);
});
test("console: first estimate after release is split release..first day by Steam's shape and conserves units", () => {
  const w = new Map([[R, 6000], ["2026-10-09", 2000]]);
  const u = consoleDailyUnits([{ date: "2026-10-09", units: 800 }], w, R);
  assert.equal(u.get(R), 600); assert.equal(u.get("2026-10-09"), 200);
});
test("console: a gap is split by Steam's shape, a decrease stays blank, missing weights go to the later day, zero estimates start nothing", () => {
  const w = new Map([[R, 6000], ["2026-10-09", 2000], ["2026-10-10", 1000], ["2026-10-11", 1000]]);
  const u = consoleDailyUnits([{ date: R, units: 100 }, { date: "2026-10-11", units: 400 }], w, R);
  assert.equal(u.get("2026-10-09"), 150); assert.equal(u.get("2026-10-10"), 75); assert.equal(u.get("2026-10-11"), 75);
  assert.equal(consoleDailyUnits([{ date: R, units: 100 }, { date: "2026-10-09", units: 90 }], w, R).get("2026-10-09"), null);
  assert.equal(consoleDailyUnits([{ date: R, units: 100 }, { date: "2026-10-12", units: 200 }], w, R).get("2026-10-12"), 100);
  assert.equal(consoleDailyUnits([{ date: R, units: 0 }, { date: "2026-10-09", units: 0 }], w, R).size, 0);
});
