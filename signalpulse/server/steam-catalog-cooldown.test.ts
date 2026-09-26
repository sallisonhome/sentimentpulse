import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileSteamCatalogCooldown, retryAfterMs, SteamCatalogDeferred } from "./steam-catalog-cooldown";
import { fetchSteamCatalogJson } from "./sales-catalog-steam-http";
import { planSalesCoverage } from "./sales-catalog-reconcile";
import Database from "better-sqlite3";
const require = createRequire(import.meta.url);

test("429 defers the whole cohort, survives a new client, expires, and never shortens Retry-After",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-shared-"));let time=Date.parse("2026-09-26T09:00Z"),calls=0;
  const path=join(dir,"gate.json"),gate=()=>fileSteamCatalogCooldown(path,()=>time);
  const fetcher=(async()=>{calls++;return new Response("",{status:429,headers:{"Retry-After":"120"}});}) as typeof fetch;
  try{
    const rows=Array.from({length:6},(_,i)=>({id:i+1,title_id:20000+i,platform:"steam" as const,
      external_sku:String(5000+i),concept_id:null,sku_role:"base",business_model:"unknown",
      msrp_usd_cents:null,business_model_source:"unavailable",is_manual_override:0,name:"Title "+i}));
    const decisions=await planSalesCoverage(rows,async(p,s,n)=>{
      await fetchSteamCatalogJson("mock",fetcher,async()=>{},gate());throw Error("unexpected");
    });
    assert.equal(calls,1);
    assert.ok(decisions.every(d=>d.status==="deferred"));
    gate().defer("1");
    const db=new Database(path);
    assert.equal((db.prepare("SELECT until_ms FROM steam_metadata_cooldown_v1").get() as any).until_ms,time+120000);
    db.close();
    time+=119999;assert.throws(()=>gate().check(),SteamCatalogDeferred);
    time++;gate().check();
    const body=await fetchSteamCatalogJson("mock",async()=>{calls++;return new Response('{"ok":true}');},async()=>{},gate());
    assert.deepEqual(body,{ok:true});assert.equal(calls,2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("HTTP date, invalid, zero and absent retry headers are safe",()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-retry-")),time=Date.parse("2026-09-26T09:00Z");
  try{
    assert.equal(retryAfterMs("Sat, 26 Sep 2026 09:05:00 GMT",time),300000);
    for(const header of [null,""," ","bad","-1","Fri, 25 Sep 2026 09:00:00 GMT","0","1e100"]){
      const p=join(dir,encodeURIComponent(String(header))+".json");
      assert.equal(fileSteamCatalogCooldown(p,()=>time).defer(header),time+60000);
    }
    assert.equal(fileSteamCatalogCooldown(join(dir,"date.json"),()=>time).defer("Sat, 26 Sep 2026 09:05:00 GMT"),time+300000);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("a crashed writer releases its lock without clearing a committed cooldown",()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-crash-")),path=join(dir,"state.sqlite");
  try{
    fileSteamCatalogCooldown(path).defer("120");
    const child=spawnSync(process.execPath,["-e",`
      const Database=require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db=new Database(${JSON.stringify(path)});
      db.exec("BEGIN IMMEDIATE; UPDATE steam_metadata_cooldown_v1 SET until_ms=0");
      process.kill(process.pid,"SIGKILL");
    `],{encoding:"utf8",timeout:10000});
    assert.equal(child.signal,"SIGKILL");
    assert.throws(()=>fileSteamCatalogCooldown(path).check(),(e:any)=>
      e instanceof SteamCatalogDeferred && e.retryAt !== null && e.retryAt>Date.now());
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("corrupt state and a busy state lock fail closed without HTTP",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-state-"));let calls=0;
  const path=join(dir,"gate.json");
  try{
    for(const raw of ["bad",'{"version":99,"until":0}','{"version":1,"until":null}']){
      writeFileSync(path,raw);
      await assert.rejects(fetchSteamCatalogJson("mock",async()=>{calls++;return new Response("{}");},async()=>{},fileSteamCatalogCooldown(path)),SteamCatalogDeferred);
    }
    rmSync(path);fileSteamCatalogCooldown(path).check();
    const lock=new Database(path);lock.exec("BEGIN IMMEDIATE");
    try{assert.throws(()=>fileSteamCatalogCooldown(path).check(),SteamCatalogDeferred);}
    finally{lock.exec("ROLLBACK");lock.close();}
    fileSteamCatalogCooldown(path).check();
    assert.equal(calls,0);
    const notDirectory=join(dir,"regular-file");
    writeFileSync(notDirectory,"not a directory");
    assert.throws(()=>fileSteamCatalogCooldown(join(notDirectory,"gate.json")).check(),SteamCatalogDeferred);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("503 Retry-After also defers across calls",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-503-"));let calls=0;
  try{
    const gate=fileSteamCatalogCooldown(join(dir,"gate.json"));
    const f=async()=>{calls++;return new Response("",{status:503,headers:{"Retry-After":"120"}});};
    await assert.rejects(fetchSteamCatalogJson("mock",f,async()=>{},gate),SteamCatalogDeferred);
    await assert.rejects(fetchSteamCatalogJson("mock",f,async()=>{},gate),SteamCatalogDeferred);
    assert.equal(calls,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("a long Retry-After on the last gateway retry still persists for the next phase",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-last-retry-"));let calls=0;
  try{
    const gate=fileSteamCatalogCooldown(join(dir,"gate.sqlite"));
    const f=async()=>new Response("",{status:++calls<3?502:504,
      headers:calls===3?{"Retry-After":"120"}:{}});
    await assert.rejects(fetchSteamCatalogJson("mock",f,async()=>{},gate),SteamCatalogDeferred);
    await assert.rejects(fetchSteamCatalogJson("mock",f,async()=>{},gate),SteamCatalogDeferred);
    assert.equal(calls,3);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("real separate processes share discovery's throttle with reconciliation; ratings remain independent",()=>{
  const dir=mkdtempSync(join(tmpdir(),"steam-process-")),root=process.cwd();
  const tsx=resolve("node_modules/.bin/tsx"),transport=resolve("server/sales-catalog-steam-http.ts");
  const discovery=resolve("server/signals/console/discovery.ts");
  try{
    const first=join(dir,"first.mts"),second=join(dir,"second.mts");
    writeFileSync(first,`import {classifySteamAppIds} from ${JSON.stringify(discovery)};
      let calls=0;globalThis.fetch=async()=>{calls++;return new Response("",{status:429,headers:{"Retry-After":"120"}})};
      const rows=await classifySteamAppIds(["123","456"]);if(calls!==1||rows.length!==2)throw Error("discovery");
      console.log("discovery",calls);process.exit(0);`);
    writeFileSync(second,`import {fetchSteamCatalogJson} from ${JSON.stringify(transport)};
      import {SteamCatalogDeferred} from ${JSON.stringify(resolve("server/steam-catalog-cooldown.ts"))};
      import {fetchJson} from ${JSON.stringify(resolve("server/signals/console/types.ts"))};
      let calls=0;globalThis.fetch=async()=>{calls++;return new Response("{}")};
      try{await fetchSteamCatalogJson("metadata");throw Error("did not defer")}catch(e){if(!(e instanceof SteamCatalogDeferred))throw e;}
      if(calls!==0)throw Error("extra metadata request");
      await fetchJson("ratings");if(calls!==1)throw Error("ratings suppressed");console.log("reconciliation deferred; ratings allowed");`);
    for(const script of [first,second]){
      const p=spawnSync(tsx,["--tsconfig",join(root,"tsconfig.json"),script],{
        cwd:dir,env:{...process.env,STEAM_CATALOG_COOLDOWN_PATH:join(dir,"shared.json")},encoding:"utf8",timeout:30000});
      assert.equal(p.status,0,p.stdout+p.stderr);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
