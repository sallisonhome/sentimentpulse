import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { boardResponseCache } from "./board-response-cache";

test("board response cache: hit within TTL, expiry, bypass, no caching of errors", async () => {
  let t = 1000, calls = 0;
  const app = express();
  app.get("/b", boardResponseCache({ ttlMs: 100, now: () => t }), (req, res) => {
    calls++;
    if (req.query.fail) return res.status(500).json({ error: "x" });
    res.json({ n: calls });
  });
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const get = async (p: string, h: Record<string, string> = {}) => { const r = await fetch(base + p, { headers: h }); return { j: await r.json() as any, c: r.headers.get("x-board-cache"), s: r.status }; };
    assert.deepEqual((await get("/b?window=d7")).j, { n: 1 });
    const hit = await get("/b?window=d7"); assert.deepEqual(hit.j, { n: 1 }); assert.equal(hit.c, "hit"); assert.equal(calls, 1);
    assert.deepEqual((await get("/b?window=d30")).j, { n: 2 });
    t += 101; assert.deepEqual((await get("/b?window=d7")).j, { n: 3 });
    assert.deepEqual((await get("/b?window=d7&nocache=1")).j, { n: 4 });
    assert.deepEqual((await get("/b?window=d7", { authorization: "Bearer x" })).j, { n: 5 });
    assert.equal((await get("/b?fail=1")).s, 500); assert.equal((await get("/b?fail=1")).s, 500); assert.equal(calls, 7);
  } finally { srv.close(); }
});
