import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { isFriendsPassName, isFriendsPassSku } from "./friends-pass-identity";
import { createDemoVerifier, hasFreePassPackage, hasExactDemoDownload } from "./metadata";
import { SHARED_RUNTIME_PASS_REFERENCES } from "../../../shared/friends-pass-reference";

test("shared-runtime reference records contain evidence, not leaderboard metrics or roster seeds",()=>{
  assert.equal(SHARED_RUNTIME_PASS_REFERENCES.length,5);
  assert.equal(new Set(SHARED_RUNTIME_PASS_REFERENCES.map(r=>r.packageId)).size,5);
  assert.equal(SHARED_RUNTIME_PASS_REFERENCES.filter(r=>r.listingKind==="base_game_offer").length,2);
  assert.equal(SHARED_RUNTIME_PASS_REFERENCES.filter(r=>r.listingKind==="pass_storefront").length,3);
  for(const row of SHARED_RUNTIME_PASS_REFERENCES){
    assert.deepEqual(Object.keys(row).sort(),["name","storeAppId","runtimeAppId","packageId","listingKind",
      "storeUrl","offerEvidenceUrl","runtimeEvidenceUrl","verifiedOn"].sort());
    for(const id of [row.storeAppId,row.runtimeAppId,row.packageId])assert.match(id,/^[1-9]\d*$/);
    assert.equal(new URL(row.offerEvidenceUrl).searchParams.get("appids"),row.storeAppId);
    assert.equal(new URL(row.runtimeEvidenceUrl).searchParams.get("packageids"),row.packageId);
    assert.equal(new URL(row.storeUrl).hostname,"store.steampowered.com");
    assert.ok(row.storeUrl.includes(`/app/${row.storeAppId}/`));
    assert.match(row.verifiedOn,/^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.storeAppId===row.runtimeAppId,row.listingKind==="base_game_offer");
    if(row.listingKind==="base_game_offer")assert.equal(isFriendsPassSku(row.storeAppId,row.name),false);
  }
});

test("reference component renders five sourced entries and explicit non-measurement scope",async()=>{
  const React=await import("react");
  const {renderToStaticMarkup}=await import("react-dom/server");
  const {FriendsPassReference}=await import("../../../client/src/components/friends-pass-reference");
  const html=renderToStaticMarkup(React.createElement(FriendsPassReference));
  for(const row of SHARED_RUNTIME_PASS_REFERENCES)assert.ok(html.includes(`reference-pass-${row.storeAppId}`));
  assert.equal((html.match(/Package-to-runtime evidence/g)??[]).length,5);
  assert.equal((html.match(/Steam offer evidence/g)??[]).length,5);
  assert.ok(html.includes("not separately measurable"));
  assert.ok(html.includes("adds no leaderboard rows, ranks or totals"));
  assert.ok(html.includes("not a complete or automatically refreshed"));
  assert.ok(!html.includes("<table"),"not a second metrics leaderboard");
  assert.ok(!html.includes("130×")&&!html.includes("130× trial"),"no download multiplier on reference entries");
});

test("Friends Pass names, free offers and hybrid identity stay distinct from paid games", async () => {
  for (const name of ["Friend's Pass","Friends' Pass","Friend’s Pass","FriendsPass","Friend Pass","Friends&#039; Pass"]) assert.ok(isFriendsPassName(name),name);
  for (const name of ["Friends of the Kingdom Season Pass","Friendship Game","Demo","Pass the Friend"]) assert.ok(!isFriendsPassName(name),name);
  assert.ok(isFriendsPassSku("1106040","Wolfenstein: Youngblood Demo"));
  assert.ok(!isFriendsPassSku("1056960","Wolfenstein: Youngblood"),"paid parent is never a pass SKU");
  const form=`<form name="add_to_cart_42" action="https://store.steampowered.com/freelicense/addfreelicense/"></form><a href="javascript:addToCart( 42);">Play</a>`;
  assert.ok(hasFreePassPackage(form,[42]));
  assert.ok(!hasFreePassPackage(form,[43]));
  assert.ok(!hasFreePassPackage(form.replace("freelicense/addfreelicense/","cart/"),[42]));
  const runOffer=`<a href="javascript:ShowGotSteamModal('steam://run/1377150', &quot;Pass&quot;, 'Play this game now')"><span>Play Game</span></a>`;
  assert.ok(hasExactDemoDownload(runOffer,"1377150",true));
  assert.ok(!hasExactDemoDownload(runOffer,"1377150"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.includes("/api/appdetails")) return Response.json({"2":{success:true,data:{steam_appid:2,packages:[42]}}});
      if (url.hostname === "store.steampowered.com") return new Response(url.pathname === "/app/2/" ? form :
        `<a href="steam://install/1">Download Demo</a><a href="steam://install/5">Download Demo</a>`);
      const ids=JSON.parse(url.searchParams.get("input_json")!).ids;
      return Response.json({response:{store_items:ids.map(({appid:id}:any)=>({
        id,appid:id,success:1,visible:true,type:id===2||id===500?0:id===600?6:1,
        name:id===6?"Not a Pass":`Fixture Friend's Pass ${id}`,is_free:id===2?undefined:true,
        related_items:{parent_appid:id===5?600:500},release:{steam_release_date:1,is_coming_soon:id===4}
      }))}});
    };
    const result=await createDemoVerifier(0,"friends_pass").verify(["1","2","3","4","5","6"]);
    assert.ok(result.get("1")?.demo);
    assert.ok(result.get("2")?.demo,"free package verified even when is_free missing");
    for(const id of ["3","4","5","6"]) assert.equal(result.get(id)?.demo,null,id);
    assert.equal((await createDemoVerifier(0).verify(["1"])).get("1")?.demo,null,"no pass in demos");
    globalThis.fetch=async()=>new Response("rate limited",{status:429});
    assert.match((await createDemoVerifier(0,"friends_pass").verify(["1"])).get("1")?.error??"",/429/);
  } finally { globalThis.fetch=original; }
});

test("pass backfill requires authentication and does not broaden the ops token",async()=>{
  const saved={AUTH_MODE:process.env.AUTH_MODE,SABER_AUTH_JWT_SECRET:process.env.SABER_AUTH_JWT_SECRET,INGESTION_OPS_TOKEN:process.env.INGESTION_OPS_TOKEN};
  let server:any;
  try {
    process.env.AUTH_MODE="saber";process.env.SABER_AUTH_JWT_SECRET="fixture-jwt-secret";process.env.INGESTION_OPS_TOKEN="fixture-pass-token";
    const app=express();app.use((await import("../../saber-auth")).createSaberAuthMiddleware().middleware);
    app.post("/api/ops/friends-pass-backfill",(_req,res)=>res.json({ok:true}));
    app.post("/api/ops/unlisted",(_req,res)=>res.json({ok:true}));
    server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const headers of [{},{"x-ops-token":"wrong"}])assert.equal((await fetch(`${base}/api/ops/friends-pass-backfill`,{method:"POST",headers})).status,401);
    assert.equal((await fetch(`${base}/api/ops/friends-pass-backfill`,{method:"POST",headers:{"x-ops-token":"fixture-pass-token"}})).status,200);
    assert.equal((await fetch(`${base}/api/ops/unlisted`,{method:"POST",headers:{"x-ops-token":"fixture-pass-token"}})).status,401);
  } finally {
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const [key,value] of Object.entries(saved))value===undefined?delete process.env[key]:process.env[key]=value;
  }
});

test("Friend's Pass pagination, cohort isolation, migration and own-SKU metrics", async () => {
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"friends-pass-"));
  process.chdir(dir);
  let db:any,server:any;
  try {
    const mod=await import("./friends-pass");
    const makeRow=(id:number,name:string)=>`<a class="search_result_row ds_collapse_flag" data-ds-appid="${id}"><span class="title">${name}</span></a>`;
    const seen:number[]=[];
    const result=await mod.discoverFriendsPassIds(async url=>{
      const start=Number(new URL(url).searchParams.get("start"));seen.push(start);
      const rows=start===0?Array.from({length:100},(_,i)=>makeRow(i+1,"Unrelated Game")):[makeRow(999,"Late Friend's Pass")];
      return JSON.stringify({success:1,total_count:101,results_html:rows.join("")});
    },0);
    assert.equal(result.error,null);assert.deepEqual(result.ids,["999"]);
    assert.equal(seen.filter(x=>x===100).length,4,"all query variants exhaust pages");
    const failed=await mod.discoverFriendsPassIds(async url=>{
      if(Number(new URL(url).searchParams.get("start"))>0)throw new Error("fixture outage");
      return JSON.stringify({success:1,total_count:200,results_html:Array.from({length:100},(_,i)=>makeRow(i+1,"Example Friend Pass")).join("")});
    },0);
    assert.match(failed.error??"",/outage/);assert.equal(failed.ids.length,100,"partial candidates retained but not claimed complete");
    db=(await import("../../storage")).rawSqlite;
    const {sumNonOverlappingReviews}=await import("./estimator");
    const unix=(d:string)=>Date.parse(d)/1000;
    const overlapping=[
      {start:unix("2026-08-01"),grain:"month",count:100,seen:"2026-09-22"},
      {start:unix("2026-09-01"),grain:"month",count:20,seen:"2026-09-22"},
      {start:unix("2026-08-23"),grain:"day",count:3,seen:"2026-09-22"},
      {start:unix("2026-09-21"),grain:"day",count:2,seen:"2026-09-22"},
      {start:unix("2026-08-01"),grain:"week",count:999,seen:"2026-09-01"}];
    assert.equal(sumNonOverlappingReviews(overlapping,null),120,"no day/rollup or week/month double counting");
    assert.equal(sumNonOverlappingReviews(overlapping,unix("2026-09-15")),2,"short window uses daily buckets");
    assert.ok(db.prepare("SELECT * FROM pragma_table_info('demo_titles') WHERE name='sku_kind'").get());
    const {upsertDiscoveredDemo}=await import("./discovery");
    upsertDiscoveredDemo({steamAppId:"999",name:"Example Friend Pass",genre:"Action",releaseDate:"2025-01-01",skuKind:"friends_pass",discoveredVia:"steam_friends_pass_search"});
    upsertDiscoveredDemo({steamAppId:"998",name:"Real Demo",genre:"Strategy",releaseDate:"2025-01-01",discoveredVia:"manual"});
    upsertDiscoveredDemo({steamAppId:"997",name:"Legacy FriendsPass",genre:"Casual",releaseDate:"2025-01-01",discoveredVia:"manual"});
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('999',?,'month',10,2,'fixture',?)`).run(Math.floor(Date.now()/1000)-100,now);
    // Large parent metrics never participate in the pass model.
    db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('123456',?,'month',999999,0,'fixture',?)`).run(Math.floor(Date.now()/1000)-100,now);
    (await import("./estimator")).computeDemoWindowEstimates(undefined,new Set(["999"]));
    const app=express();(await import("../../routes-demos-leaderboard")).registerDemosLeaderboardRoutes(app);
    server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    const base=`http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    const demos=await(await fetch(base)).json() as any;
    assert.deepEqual(demos.demos.map((r:any)=>r.steamAppId),["998"]);
    assert.deepEqual(demos.genres,["Strategy"]);
    for(const window of ["d7","d30","d90","m12","ltd"]) {
      const pass=await(await fetch(`${base}?kind=friends_pass&window=${window}`)).json() as any;
      assert.equal(pass.count,1);assert.equal(pass.demos[0].unitsMid,12*130);
      assert.equal(pass.demos[0].ccuCurrent,null);assert.equal(pass.demos[0].reviewCountTotal,12);
      assert.deepEqual(pass.genres,["Action"]);
    }
    assert.equal((await fetch(`${base}?kind=wrong`)).status,400);
    assert.equal((await fetch(`${base}?kind=friends_pass&sort=top`)).status,400);
    db.prepare("UPDATE demo_titles SET is_active=0 WHERE steam_app_id='999'").run();
    assert.equal(((await(await fetch(`${base}?kind=friends_pass&window=ltd`)).json()) as any).count,0);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally {
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
