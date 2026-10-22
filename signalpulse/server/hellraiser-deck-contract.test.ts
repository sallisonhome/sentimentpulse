import test from "node:test";
import assert from "node:assert/strict";
import {
  HELLRAISER_DECK_CONTRACT,
  HELLRAISER_DECK_CONTRACT_TAG,
  applyHellraiserDeckContract,
  hellraiserPs5DailySeries,
  hellraiserPs5WindowUnits,
  isHellraiserDeckContractGroup,
} from "./hellraiser-deck-contract";

// Steam base-SKU daily units for the Hellraiser product. The 10-08..10-21
// total is the real production figure (125,676); individual early-launch
// days are a plausible shape (the contract only depends on the shape, not
// the specific values, for allocation shares). Continuation days are actuals
// as they arrive.
const a = HELLRAISER_DECK_CONTRACT.anchor;
function iso(offsetFromLaunch: number): string {
  const dt = new Date(`${a.launchWindowStart}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offsetFromLaunch);
  return dt.toISOString().slice(0, 10);
}
const launchShape = [42000, 18000, 9500, 7000, 5800, 5000, 4400, 3900, 3400, 3000, 5069, 3909, 2580, 2209, 1980];
// Shape above has 15 days but the launch window is 14 days (10-08..10-21); trim to exact total.
function buildSteamDaily(): Array<{ date: string; units: number }> {
  const days: Array<{ date: string; units: number }> = [];
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const u = launchShape[i];
    days.push({ date: iso(i), units: u });
    total += u;
  }
  // Force the launch-window total to the real 125,676 via the last day.
  days[13].units += a.launchWindowSteamUnits - total;
  // Continuation: first post-anchor Steam actual day.
  days.push({ date: iso(14), units: 1700 });
  return days;
}

const steamDaily = buildSteamDaily();

test("contract constants match the operator directive", () => {
  assert.equal(a.units, 145300); // "PS5 actual units are 145.3K" (user, 2026-10-22)
  assert.equal(a.asOfDate, "2026-10-21");
  assert.equal(HELLRAISER_DECK_CONTRACT.aspUsdCents.console, 3305); // $33.05 console
  // $40 Steam retained as documentation of the original directive but NOT
  // applied — Steam serves Steamworks actuals (amendment 2026-10-22).
  assert.equal(HELLRAISER_DECK_CONTRACT.aspUsdCents.steam, 4000);
});

test("allocation conserves the anchor exactly (largest-remainder, sum = 145,300)", () => {
  const series = hellraiserPs5DailySeries(steamDaily);
  let sum = 0;
  for (const [d, u] of series) {
    if (d >= a.launchWindowStart && d <= a.asOfDate) sum += u;
  }
  assert.equal(sum, a.units);
});

test("LTD through the anchor date is exactly the anchor", () => {
  assert.equal(hellraiserPs5WindowUnits("ltd", a.asOfDate, steamDaily), a.units);
  assert.equal(hellraiserPs5WindowUnits("m12", a.asOfDate, steamDaily), a.units);
  assert.equal(hellraiserPs5WindowUnits("d90", a.asOfDate, steamDaily), a.units);
  assert.equal(hellraiserPs5WindowUnits("d30", a.asOfDate, steamDaily), a.units);
});

test("continuation after the anchor adds Steam dailies at the through-anchor ratio", () => {
  const ratio = a.units / a.steamUnitsThroughAnchor;
  const series = hellraiserPs5DailySeries(steamDaily);
  assert.equal(series.get(iso(14)), Math.round(1700 * ratio));
  const ltdAfter = hellraiserPs5WindowUnits("ltd", iso(14), steamDaily);
  assert.equal(ltdAfter, a.units + Math.round(1700 * ratio));
});

test("d7 through the anchor date sums only the last 7 allocation days", () => {
  const series = hellraiserPs5DailySeries(steamDaily);
  let expected = 0;
  for (let i = 7; i < 14; i++) expected += series.get(iso(i)) ?? 0;
  assert.equal(hellraiserPs5WindowUnits("d7", a.asOfDate, steamDaily), expected);
  assert.ok(expected > 0 && expected < a.units);
});

test("windows ending before release have no PS5 units", () => {
  assert.equal(hellraiserPs5WindowUnits("d7", "2026-10-07", steamDaily), 0);
  assert.equal(hellraiserPs5WindowUnits("ltd", "2026-10-07", steamDaily), 0);
});

test("unknown windows return null", () => {
  assert.equal(hellraiserPs5WindowUnits("d1", a.asOfDate, steamDaily), null);
});

test("applyHellraiserDeckContract sets PS5 units + revenue at the console ASP", () => {
  const groups: Array<Record<string, unknown>> = [
    {
      editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey,
      familyTitleIds: [HELLRAISER_DECK_CONTRACT.titleIds.ps5],
      unitsMid: 99999,
      ownersMid: 80000,
      revenueMidUsd: 3200000,
      method: "ltd-anchor-median-v03",
    },
  ];
  const touched = applyHellraiserDeckContract(groups, "ps5", "ltd", steamDaily);
  assert.equal(touched, 1);
  const g = groups[0];
  // asOf is the max Steam actual date in the fixture (launch+1 = 2026-10-22),
  // so LTD = anchor 145,300 + one continuation day (1700 × ratio, rounded).
  const ratio = a.units / a.steamUnitsThroughAnchor;
  const expectedLtd = a.units + Math.round(1700 * ratio);
  assert.equal(g.unitsMid, expectedLtd);
  assert.equal(g.revenueMidUsd, Math.round((expectedLtd * 3305) / 100));
  assert.equal(g.aspUsdCents, 3305);
  assert.equal(g.dataSource, "operator_anchor_contract");
  assert.match(String(g.method), new RegExp(HELLRAISER_DECK_CONTRACT_TAG));
  assert.match(String(g.estimateMethod), new RegExp(HELLRAISER_DECK_CONTRACT_TAG)); // serialized field
  assert.equal(g.unitsMidEstimated, 99999); // prior estimate kept visible
  assert.equal(g.ownersMid, Math.max(1, Math.round(80000 * (expectedLtd / 99999)))); // scaled with units
});

test("applyHellraiserDeckContract restates Xbox revenue at the console ASP; Steam serves actuals untouched", () => {
  const xbox: Array<Record<string, unknown>> = [
    { editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey, familyTitleIds: [11355], unitsMid: 54800, revenueMidUsd: 1753000, method: "m" },
  ];
  assert.equal(applyHellraiserDeckContract(xbox, "xbox", "ltd", steamDaily), 1);
  assert.equal(xbox[0].unitsMid, 54800);
  assert.equal(xbox[0].revenueMidUsd, Math.round((54800 * 3305) / 100));
  assert.equal(xbox[0].aspUsdCents, 3305);

  // Steam is NOT restated to the operator ASP — the operator has Steamworks
  // actuals for Hellraiser and all Saber titles (amendment 2026-10-22), so
  // the Steam row keeps serving actuals unchanged.
  const steam: Array<Record<string, unknown>> = [
    { editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey, familyTitleIds: [10664], unitsMid: 167327, revenueMidUsd: 6887000, method: "m" },
  ];
  assert.equal(applyHellraiserDeckContract(steam, "steam", "ltd", steamDaily), 0);
  assert.equal(steam[0].unitsMid, 167327);
  assert.equal(steam[0].revenueMidUsd, 6887000); // actuals unchanged
  assert.equal(steam[0].aspUsdCents, undefined);
});

test("unrelated families are untouched", () => {
  const groups: Array<Record<string, unknown>> = [
    { editionGroupKey: "red dead redemption 2", familyTitleIds: [11561], unitsMid: 15000, revenueMidUsd: 500000, method: "m" },
  ];
  assert.equal(applyHellraiserDeckContract(groups, "ps5", "ltd", steamDaily), 0);
  assert.equal(groups[0].unitsMid, 15000);
  assert.equal(groups[0].revenueMidUsd, 500000);
  assert.ok(isHellraiserDeckContractGroup({ editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey }));
  assert.ok(!isHellraiserDeckContractGroup({ editionGroupKey: "red dead redemption 2", familyTitleIds: [11561] }));
});

test("the contract is durable: it derives from the anchor constants, not from stored estimates", () => {
  // Same Steam actuals + anchor → same values regardless of the stored row.
  const g1: Array<Record<string, unknown>> = [
    { editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey, familyTitleIds: [11296], unitsMid: 1, revenueMidUsd: 1, method: "m" },
  ];
  const g2: Array<Record<string, unknown>> = [
    { editionGroupKey: HELLRAISER_DECK_CONTRACT.familyKey, familyTitleIds: [11296], unitsMid: 999999, revenueMidUsd: 999999, method: "m" },
  ];
  applyHellraiserDeckContract(g1, "ps5", "ltd", steamDaily);
  applyHellraiserDeckContract(g2, "ps5", "ltd", steamDaily);
  assert.equal(g1[0].unitsMid, g2[0].unitsMid);
  assert.equal(g1[0].revenueMidUsd, g2[0].revenueMidUsd);
});
