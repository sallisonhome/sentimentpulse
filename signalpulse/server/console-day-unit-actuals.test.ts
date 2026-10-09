import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_DAY_UNIT_ACTUALS, CONSOLE_DAY_ACTUAL_TAG, consoleDayActualFor, anchoredLtdUnits, windowContainsDay, relevelConsoleLtd, type ConsoleDayUnitActual } from "./console-day-unit-actuals";

const A: ConsoleDayUnitActual = {
  titleId: 11296, platform: "ps5", date: "2026-10-08", units: 49200,
  standardShare: 0.45, deluxeShare: 0.55, baselineLtdUnits: 16042,
  source: "operator-reported PS5 day-one units (2026-10-09)",
};

test("the shipped anchor is Hellraiser PS5 D1: 49,200 units, 55/45 mix, baseline 16,042", () => {
  assert.equal(CONSOLE_DAY_UNIT_ACTUALS.length, 1);
  const a = CONSOLE_DAY_UNIT_ACTUALS[0];
  assert.deepEqual({ ...a, source: a.source }, { ...A, source: a.source });
  assert.equal(consoleDayActualFor(11296, "ps5"), a);
  assert.equal(consoleDayActualFor(11296, "xbox"), undefined);
  assert.equal(consoleDayActualFor(10990, "ps5"), undefined);
  assert.equal(consoleDayActualFor(11355, "xbox"), undefined);
});

test("anchoredLtdUnits: actual + native increments; a decrease clamps at the actual; tagged rows pass through", () => {
  assert.equal(anchoredLtdUnits(A, 16042, false), 49200);
  assert.equal(anchoredLtdUnits(A, 30789, false), 63947);
  assert.equal(anchoredLtdUnits(A, 10000, false), 49200); // revised-down native never lowers the actual
  assert.equal(anchoredLtdUnits(A, 123456, false), 156614);
  assert.equal(anchoredLtdUnits(A, 98765, true), 98765); // estimator already wrote the anchored value
});

test("windowContainsDay: windows carry the anchor only while the day is inside them; ltd always", () => {
  assert.equal(windowContainsDay("ltd", "2026-10-09", "2026-10-08"), true);
  assert.equal(windowContainsDay("ltd", "2027-06-01", "2026-10-08"), true);
  assert.equal(windowContainsDay("ltd", "2026-10-07", "2026-10-08"), false); // run dated before the actual
  assert.equal(windowContainsDay("d7", "2026-10-14", "2026-10-08"), true);  // last day d7 contains it
  assert.equal(windowContainsDay("d7", "2026-10-15", "2026-10-08"), false); // rolled out
  assert.equal(windowContainsDay("d30", "2026-11-06", "2026-10-08"), true);
  assert.equal(windowContainsDay("d30", "2026-11-07", "2026-10-08"), false);
  assert.equal(windowContainsDay("m12", "2027-10-07", "2026-10-08"), true);
  assert.equal(windowContainsDay("m12", "2027-10-08", "2026-10-08"), false);
});

test("relevelConsoleLtd: D1 is exactly the actual, later days are actual + native deltas, pre-anchor rows untouched", () => {
  const out = relevelConsoleLtd(
    [
      { date: "2026-10-07", units: null, method: null },
      { date: "2026-10-08", units: 16042, method: "ltd-anchor-median-v03" },
      { date: "2026-10-09", units: 30789, method: "ltd-anchor-median-v03" },
    ],
    A,
  );
  assert.equal(out[0].units, null);
  assert.equal(out[1].units, 49200);
  assert.equal(out[2].units, 63947);
});

test("relevelConsoleLtd: a revised native D1 above the actual still loses to the actual", () => {
  const out = relevelConsoleLtd([{ date: "2026-10-08", units: 55000, method: null }], A);
  assert.equal(out[0].units, 49200);
});

test("relevelConsoleLtd: rows the estimator already tagged pass through, so a mixed history is never double-lifted", () => {
  const out = relevelConsoleLtd(
    [
      { date: "2026-10-08", units: 49200, method: `x+${CONSOLE_DAY_ACTUAL_TAG}` },
      { date: "2026-10-09", units: 63947, method: `x+${CONSOLE_DAY_ACTUAL_TAG}+ltd_state:derived_max_windows` },
    ],
    A,
  );
  assert.equal(out[0].units, 49200);
  assert.equal(out[1].units, 63947);
});

test("relevelConsoleLtd: a native later row below the baseline clamps at the actual (decrease reads as flat, not negative)", () => {
  const out = relevelConsoleLtd([{ date: "2026-10-09", units: 12000, method: null }], A);
  assert.equal(out[0].units, 49200);
});
