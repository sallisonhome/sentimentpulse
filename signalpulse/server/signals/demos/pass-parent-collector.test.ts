import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(),"paired-ccu-test-"));
process.chdir(dir);
const { collectPair } = await import("./pass-parent-activity");
const { rawSqlite } = await import("../../storage");
test.after(() => { rawSqlite.close(); process.chdir(cwd); rmSync(dir,{recursive:true,force:true}); });

test("collector launches requests before either response and records real receipt timing", async () => {
  let active=0,max=0,t=0;
  const read=async (id:string) => { active++; max=Math.max(max,active); await new Promise(r=>setTimeout(r,10));
    active--; return id==="pass"?5:20; };
  const clock=()=>new Date(Date.UTC(2026,8,23,16,0,0,t++)).toISOString();
  const r=await collectPair("pass","parent",read,clock);
  assert.equal(max,2); assert.equal(r.pass_ccu,5); assert.equal(r.parent_ccu,20);
  assert.equal(r.captured_at, r.pass_received_at > r.parent_received_at ? r.pass_received_at : r.parent_received_at);
});
test("collector abstains when either endpoint is unavailable", async () => {
  await assert.rejects(()=>collectPair("pass","parent",async id=>id==="pass"?null:20),/unavailable/);
});
test("mapping requires exact own launch and explicit parent; packages and fuzzy names are not evidence", async () => {
  const {verifyPassParent}=await import("./pass-parent-activity");
  const original=globalThis.fetch;
  let launch=true, parent="200", ownType="demo", wrongId=false, calls=0;
  globalThis.fetch=(async (input:any) => {
    calls++;
    const url=new URL(String(input)), id=url.searchParams.get("appids");
    const response=id ? Response.json({[id]:{success:true,data:{
      steam_appid:wrongId?999:Number(id),name:id==="100"?"Example Friend Pass":"Example",
      type:id==="100"?ownType:"game",fullgame:id==="100"?{appid:parent}:undefined,
    }}}) : new Response(launch?'<a href="steam://install/100">Download</a>':'<a href="steam://install/200">Play Game</a>');
    Object.defineProperty(response,"url",{value:url.href});
    return response;
  }) as typeof fetch;
  try {
    assert.equal((await verifyPassParent("100")).status,"verified");
    launch=false; assert.equal((await verifyPassParent("100")).status,"unverified");
    launch=true; parent="100"; assert.equal((await verifyPassParent("100")).status,"unverified");
    parent="200"; ownType="game"; assert.equal((await verifyPassParent("100")).status,"unverified");
    wrongId=true; await assert.rejects(()=>verifyPassParent("100"),/identity unavailable/);
    const before=calls; assert.equal((await verifyPassParent("3052150")).status,"shared_runtime");
    assert.equal(calls,before,"known shared runtime never requests misleading own endpoint");
  } finally {globalThis.fetch=original;}
});
test("isolated DB collector and real HTTP route preserve metrics and enforce API scope", async () => {
  const { upsertDiscoveredDemo } = await import("./discovery");
  const { runPassParentActivityCollector } = await import("./pass-parent-activity");
  for (const [id,name] of [["100","A Pass"],["101","B Pass"],["102","Unverified Pass"],["3052150","Split Fiction Friend Pass"]])
    upsertDiscoveredDemo({steamAppId:id,name,skuKind:"friends_pass",genre:"Action",releaseDate:null,discoveredVia:"manual"});
  const tables=["demo_download_actuals","demo_window_estimates_daily","demo_ccu_snapshots"];
  const counts=()=>tables.map(t=>rawSqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get());
  const before=counts(),verified:string[]=[];
  const verify=async (id:string) => {
    verified.push(id);
    return {status:id==="102"?"unverified" as const:"verified" as const,parent_app_id:"200",parent_name:"Parent",
      evidence_url:"https://evidence.example/fixture",verified_at:new Date().toISOString()};
  };
  const collect=async(id:string,parent:string)=>collectPair(id,parent,async app=>app==="200"?100:app==="100"?50:0);
  const run=await runPassParentActivityCollector(0,new Set(["100","101","102","3052150"]),verify,collect);
  assert.equal(run.succeeded,2); assert.equal(run.unavailable,2); assert.equal(run.failed,0);
  assert.ok(!verified.includes("3052150"),"shared runtimes blocked before verification/collection");
  assert.deepEqual(counts(),before,"no parent writes to download or own-CCU tables");
  const express=(await import("express")).default, app=express();
  (await import("../../routes-demos-leaderboard")).registerDemosLeaderboardRoutes(app);
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/demos/leaderboard`;
  try {
    for(const window of ["d7","d30","d90","m12","ltd"]) for(const direction of ["asc","desc"]) {
      const r=await(await fetch(`${base}?kind=friends_pass&sort=activity&window=${window}&direction=${direction}`)).json() as any;
      assert.equal(r.demos[0].steamAppId,direction==="desc"?"100":"101");
      assert.equal(r.demos[0].passParentActivity.ratio,direction==="desc"?.5:0);
      assert.ok(r.demos.slice(2).every((d:any)=>d.passParentActivity.ratio===null));
      assert.ok(r.demos.every((d:any)=>d.playerEstimate.players===null && d.unitsMid===null));
    }
    const paged=await(await fetch(`${base}?kind=friends_pass&sort=activity&limit=1&offset=1`)).json() as any;
    assert.equal(paged.demos[0].steamAppId,"101");
    for(const activityWindow of ["d7","d30"]) {
      const r=await(await fetch(`${base}?kind=friends_pass&activityWindow=${activityWindow}`)).json() as any;
      assert.ok(r.demos.every((d:any)=>d.passParentActivity.ratio===null));
    }
    assert.equal((await fetch(`${base}?kind=demo&sort=activity`)).status,400);
    assert.equal((await fetch(`${base}?kind=friends_pass&activityWindow=ltd`)).status,400);
    const defaults=await(await fetch(`${base}?kind=friends_pass`)).json() as any;
    assert.equal(defaults.sort,"downloads"); assert.equal(defaults.activityWindow,"latest");
    const failure=await runPassParentActivityCollector(0,new Set(["100"]),verify,async()=>{throw Error("endpoint failure");});
    assert.equal(failure.failed,1);
    const r=await(await fetch(`${base}?kind=friends_pass&search=A%20Pass`)).json() as any;
    assert.equal(r.demos[0].passParentActivity.status,"failed"); assert.equal(r.demos[0].passParentActivity.ratio,null);
    assert.equal(rawSqlite.prepare("SELECT count(*) n FROM pass_parent_ccu_pairs").get()!.n,2,"failure retains historical pairs");
    assert.deepEqual(counts(),before);
    assert.equal(rawSqlite.pragma("integrity_check",{simple:true}),"ok");
    assert.deepEqual(rawSqlite.pragma("foreign_key_check"),[]);
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
});
