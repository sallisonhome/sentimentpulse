import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { getPassScenario, passScenarioCsv } from "./pass-scenarios";
import { registerPassScenarioRoutes } from "../../routes-pass-scenarios";

test("reviewed June-August inputs reproduce the local research, not unique-player counts", () => {
  const lords = getPassScenario(), itt = getPassScenario({title:"it-takes-two"});
  assert.ok(Math.abs(lords.summary.estimateAvgCcu-342.12688405797104)<1e-8);
  assert.ok(Math.abs(itt.summary.estimateAvgCcu-1908.2535133986435)<1e-8);
  assert.equal(lords.summary.months,3);
  assert.equal(lords.summary.hours,2208);
  assert.equal(lords.summary.sensitivityLowAvgCcu,0);
  assert.equal(lords.metric,"incremental_guest_equivalent_ccu");
  assert.equal(itt.metric,"estimated_total_pass_client_ccu");
  for(const r of [lords,itt]) {
    assert.equal(r.observed,false);
    assert.equal(r.excludedFromActualsAndTotals,true);
    assert.equal(r.automaticDownstreamApplication,false);
    assert.ok(!("players" in r.summary) && !("downloads" in r.summary));
    assert.ok(r.sources.every(s=>s.url.startsWith("https://")));
  }
});
test("complete-month selection, hour weighting, all assumption combinations and numeric bounds", () => {
  for(const title of ["lords","it-takes-two"]) {
    const r = getPassScenario({title});
    const all = getPassScenario({title,from:r.availableFrom,through:r.availableThrough});
    for(const p of all.points) {
      const one = getPassScenario({title,from:p.month,through:p.month});
      assert.equal(one.summary.months,1);
      assert.ok(Math.abs(one.summary.estimateAvgCcu-p.estimateAvgCcu)<1e-8);
      assert.ok(p.sensitivityLowAvgCcu<=p.estimateAvgCcu && p.estimateAvgCcu<=p.sensitivityHighAvgCcu);
    }
    assert.ok(Math.abs(all.summary.estimatedPlayerHours-all.summary.estimateAvgCcu*all.summary.hours)<1e-6);
  }
  const high = getPassScenario({attribution:"1",hosts:"0"});
  const half = getPassScenario({attribution:"1",hosts:"1"});
  assert.equal(high.summary.estimateAvgCcu,2*half.summary.estimateAvgCcu);
  assert.equal(getPassScenario({attribution:"0"}).summary.estimateAvgCcu,0);
  for(const attribution of ["0","0.25","0.5","0.75","1"])
    for(const hosts of ["0","0.5","1"]) {
      const all=getPassScenario({from:"2025-05",through:"2026-08",attribution,hosts});
      assert.ok(all.points.every(p=>p.estimateAvgCcu>=0 && p.estimateAvgCcu<=p.sensitivityHighAvgCcu));
    }
});
test("unknown titles, incomplete/outside/reversed months and malformed assumptions fail closed", () => {
  for(const q of [{title:"split-fiction"},{from:"2024-04"},{through:"2026-09"},{from:"2026-08",through:"2026-06"},
    {from:"2026-6"},{from:["2026-06"]},{attribution:"NaN"},{attribution:"1.01"},{hosts:"-1"},{title:{x:"lords"}}])
    assert.throws(()=>getPassScenario(q));
});
test("CSV retains scope, source, assumptions, precision and every selected month", () => {
  const r=getPassScenario({title:"it-takes-two",from:"2026-07",through:"2026-08"});
  const csv=passScenarioCsv(r);
  assert.equal(csv.trim().split("\r\n").length,3);
  for(const s of ["observed","automatic_downstream_application","historical_transfer_share",r.metric,r.sourceSha256,
    "2026-07","2026-08","https://steamcharts.com/app/1504980"])
    assert.ok(csv.includes(s));
  assert.ok(csv.includes(String(r.points[0].estimateAvgCcu)));
});
test("real HTTP route serves JSON and matching CSV, validates errors, no mutation route", async () => {
  const app=express();registerPassScenarioRoutes(app);
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  try {
    const addr=server.address();assert.ok(addr && typeof addr!=="string");
    const url=`http://127.0.0.1:${addr.port}/api/demos/pass-scenarios`;
    const res=await fetch(url);assert.equal(res.status,200);
    assert.equal(res.headers.get("cache-control"),"private, no-store");
    const data=await res.json() as any;assert.equal(data.points.length,3);
    const csv=await fetch(`${url}?format=csv`);
    assert.equal(await csv.text(),passScenarioCsv(getPassScenario()));
    assert.match(csv.headers.get("content-disposition")!,/pass-scenario-lords-2026-06-2026-08.csv/);
    assert.equal((await fetch(`${url}?from=2026-09`)).status,400);
    assert.equal((await fetch(`${url}?format=xml`)).status,400);
    assert.equal((await fetch(url,{method:"POST"})).status,404);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test("scenario reads remain private under the existing enforcing auth mode", async () => {
  const oldMode=process.env.AUTH_MODE,oldSecret=process.env.SABER_AUTH_JWT_SECRET;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    process.env.AUTH_MODE="saber";process.env.SABER_AUTH_JWT_SECRET="isolated-test-only-not-a-real-key";
    const app=express();
    app.use((await import("../../saber-auth")).createSaberAuthMiddleware().middleware);
    registerPassScenarioRoutes(app);
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server!.once("listening",resolve));
    const addr=server.address();assert.ok(addr && typeof addr!=="string");
    for(const suffix of ["","?format=csv"])
      assert.equal((await fetch(`http://127.0.0.1:${addr.port}/api/demos/pass-scenarios${suffix}`)).status,401);
  } finally {
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    oldMode===undefined?delete process.env.AUTH_MODE:process.env.AUTH_MODE=oldMode;
    oldSecret===undefined?delete process.env.SABER_AUTH_JWT_SECRET:process.env.SABER_AUTH_JWT_SECRET=oldSecret;
  }
});
