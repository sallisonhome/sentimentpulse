import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRestateDays, steamSalesFetchDates, salesTotalsForDate, describeRestatement,
  DEFAULT_RESTATE_DAYS, MAX_RESTATE_DAYS,
} from "./steam-sales-restate";

test("default run re-fetches the prior day, then the target day", () => {
  assert.deepEqual(steamSalesFetchDates("2026-10-16", DEFAULT_RESTATE_DAYS), [
    { date: "2026-10-15", restatement: true },
    { date: "2026-10-16", restatement: false },
  ]);
});

test("restate days 0 keeps the old single-day behavior", () => {
  assert.deepEqual(steamSalesFetchDates("2026-10-16", 0), [{ date: "2026-10-16", restatement: false }]);
});

test("restatement crosses month and year boundaries", () => {
  assert.deepEqual(steamSalesFetchDates("2027-01-01", 2).map((d) => d.date),
    ["2026-12-30", "2026-12-31", "2027-01-01"]);
  assert.deepEqual(steamSalesFetchDates("2026-03-01", 1).map((d) => d.date), ["2026-02-28", "2026-03-01"]);
});

test("setting parse: missing/invalid use default, cap at max, 0 disables", () => {
  assert.equal(parseRestateDays(undefined), DEFAULT_RESTATE_DAYS);
  assert.equal(parseRestateDays(""), DEFAULT_RESTATE_DAYS);
  assert.equal(parseRestateDays("abc"), DEFAULT_RESTATE_DAYS);
  assert.equal(parseRestateDays("-1"), DEFAULT_RESTATE_DAYS);
  assert.equal(parseRestateDays("1.5"), DEFAULT_RESTATE_DAYS);
  assert.equal(parseRestateDays("0"), 0);
  assert.equal(parseRestateDays("3"), 3);
  assert.equal(parseRestateDays("99"), MAX_RESTATE_DAYS);
});

test("totals sum base and dlc for one day only; other sku groups ignored", () => {
  const rows = [
    { date: "2026-10-15", skuGroup: "base", netUnits: 5126, netRevenueUsd: 203499 },
    { date: "2026-10-15", skuGroup: "dlc", netUnits: 32, netRevenueUsd: 475 },
    { date: "2026-10-15", skuGroup: "other", netUnits: 9, netRevenueUsd: 90 },
    { date: "2026-10-14", skuGroup: "base", netUnits: 5379, netRevenueUsd: 1 },
  ];
  assert.deepEqual(salesTotalsForDate(rows, "2026-10-15"),
    { baseUnits: 5126, baseRevenueUsd: 203499, dlcUnits: 32, dlcRevenueUsd: 475 });
});

test("Oct 15 Hellraiser restatement is described; unchanged day is null", () => {
  const before = { baseUnits: 5126, baseRevenueUsd: 203499, dlcUnits: 32, dlcRevenueUsd: 475 };
  const after = { baseUnits: 5135, baseRevenueUsd: 203782, dlcUnits: 32, dlcRevenueUsd: 475 };
  assert.equal(describeRestatement("Hellraiser", "2026-10-15", before, after),
    "Hellraiser 2026-10-15: base +9 units / +283 USD, dlc 0 units / 0 USD");
  assert.equal(describeRestatement("Docked", "2026-10-15", before, before), null);
});
