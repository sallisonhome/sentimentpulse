import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSalesUnits } from "./console-sales-units";

test("final revenue back-solves units without truncating ASP cents", () => {
  const p = resolveSalesUnits(1634248.4598533332, 5999 * .8);
  assert.equal(p.unitsMid, 34053);
  assert.ok(Math.abs(p.unitsMid! * p.aspUsdCents! / 100 - 1634248.4598533332) <= p.aspUsdCents! / 200);
});
test("verified units imply realized ASP without changing authoritative revenue", () => {
  assert.deepEqual(resolveSalesUnits(1000000, 4799.2, 40000), {
    unitsMid: 40000, aspUsdCents: 2500, unitSource: "verified_anchor",
  });
});
test("unknown or invalid economics do not preserve contradictory units", () => {
  for (const asp of [null,0,-10,NaN,Infinity]) assert.equal(resolveSalesUnits(1000,asp).unitsMid,null);
  for (const revenue of [null,-1,NaN,Infinity]) assert.equal(resolveSalesUnits(revenue,1000).unitsMid,null);
  assert.equal(resolveSalesUnits(0,null,10000).unitsMid,0);
  assert.equal(resolveSalesUnits(Number.MAX_VALUE,1).unitsMid,null);
});
test("future applied revenue changes automatically change resolved units", () => {
  assert.equal(resolveSalesUnits(100000,4000).unitsMid,2500);
  assert.equal(resolveSalesUnits(120000,4000).unitsMid,3000);
});
