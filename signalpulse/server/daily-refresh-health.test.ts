import {test} from "node:test";
import assert from "node:assert/strict";
import {discoveryHealth, collectionHealth} from "./daily-refresh-health";

const discovery = (paid=45, preservedPaid=144) => ({
  steam: {paid, preservedPaid, unknown: 160}, xbox: {paid: 90}, ps: {paid: 100},
});
test("September failure: 45 fresh plus preserved known paid candidates can collect", () => {
  const result = discoveryHealth(discovery());
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
});
test("unknown new candidates cannot satisfy paid evidence floor", () => {
  assert.equal(discoveryHealth(discovery(45, 0)).errors.length, 1);
  assert.equal(discoveryHealth(discovery(45, 34)).errors.length, 1);
  assert.equal(discoveryHealth(discovery(45, 35)).errors.length, 0);
});
test("other discovery safety gates remain mandatory", () => {
  const input = discovery(); input.xbox.paid = 0; input.ps.paid = 0;
  assert.equal(discoveryHealth(input).errors.length, 2);
});
const collected = () => ({steam:{ingested:430, failed:9}, xbox:{ingested:100,failed:0}, ps5:{ingested:100,failed:0,skipped:3}});
test("current-run fresh collection tolerates bounded individual failures and reports them", () => {
  const result = collectionHealth(collected());
  assert.deepEqual(result.errors, []); assert.equal(result.warnings.length, 2);
});
test("zero fresh observations, absent platform, and widespread failures fail closed", () => {
  assert.equal(collectionHealth({}).errors.length, 3);
  const input = collected(); input.steam = {ingested:0,failed:439};
  assert.equal(collectionHealth(input).errors.length, 1);
  input.steam = {ingested:79,failed:21};
  assert.equal(collectionHealth(input).errors.length, 1);
  input.steam = {ingested:80,failed:20};
  assert.equal(collectionHealth(input).errors.length, 0);
});
