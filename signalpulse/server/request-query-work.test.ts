import { test } from "node:test";
import assert from "node:assert/strict";
import { requestQueryWork } from "./request-query-work";

test("common reads are evaluated once per request, never across requests", async () => {
  const q = requestQueryWork();
  let reads = 0;
  const get = () => q.read("a", () => ++reads);
  q.run(() => { assert.equal(get(), 1); assert.equal(get(), 1); });
  q.run(() => { assert.equal(get(), 2); assert.equal(get(), 2); });
  assert.equal(get(), 3); assert.equal(get(), 4); // no scope, no reuse
  const values = await Promise.all([1, 2].map(n => q.run(async () => {
    const first = q.read("b", () => n);
    await Promise.resolve();
    return [first, q.read("b", () => 999)];
  })));
  assert.deepEqual(values, [[1, 1], [2, 2]]);
});

test("failed reads retry and clone-owned consumers cannot mutate stored results", () => {
  const q = requestQueryWork();
  q.run(() => {
    assert.throws(() => q.read("bad", () => { throw Error("fail"); }));
    assert.equal(q.read("bad", () => 7), 7);
    const value = () => structuredClone(q.read("rows", () => ({ rows: [{ units: 3 }] })));
    value().rows[0].units = 99;
    assert.equal(value().rows[0].units, 3);
  });
});
