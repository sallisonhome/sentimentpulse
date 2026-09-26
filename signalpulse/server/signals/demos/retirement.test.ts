import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import express from "express";

test("retired demos retain PDPs, stay in metric views and daily checks without zeroing history or changing cadence",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"demo-retirement-")),realFetch=globalThis.fetch;
  process.chdir(dir);let db:any,server:any;
  try{
    db=(await import("../../storage")).rawSqlite;
    const now=new Date().toISOString(),today=now.slice(0,10);
    db.prepare(`INSERT INTO demo_titles(steam_app_id,name,genre,release_date,is_active,deactivated_at,
      availability_source,discovered_via,first_seen_at,created_at,updated_at)
      VALUES('5075680','Graveyard Keeper 2 Demo','Simulation','2026-09-14',0,'2026-09-23T07:05:56Z',
      'metadata_release','test','2026-09-22',?,?)`).run(now,now);
    const id=db.prepare("SELECT id FROM demo_titles WHERE steam_app_id='5075680'").get().id;
    db.prepare(`INSERT INTO demo_window_estimates_daily(demo_title_id,window,as_of_date,review_count_total,
      review_delta,units_mid,method,multiplier_id,created_at)
      VALUES(?,'ltd','2026-09-22',695,695,45523,'review_delta_multiplier','hellraiser_anchor_v1',?)`).run(id,now);
    db.prepare(`INSERT INTO demo_window_estimates_daily(demo_title_id,window,as_of_date,review_count_total,
      review_delta,units_mid,method,multiplier_id,created_at)
      VALUES(?,'d7','2026-09-22',695,561,36746,'review_delta_multiplier','hellraiser_anchor_v1',?)`).run(id,now);
    db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,
      recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('5075680',1789344000,'week',600,95,'fixture','2026-09-22')`).run();
    db.prepare(`INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES(?,'2026-09-22T16:26:34Z',19257)`).run(id);
    const app=express();
    (await import("../../routes-demo-detail")).registerDemoDetailRoutes(app);
    (await import("../../routes-demos-leaderboard")).registerDemosLeaderboardRoutes(app);
    server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const get=async(path:string)=>{const r=await realFetch(base+path);assert.equal(r.status,200);return r.json();};
    const before=await get("/api/demos/titles/5075680?days=all");
    assert.equal(before.archived,true);assert.equal(before.deactivatedAt,"2026-09-23T07:05:56Z");
    assert.equal(before.latest.reviews,695);assert.equal(before.latest.downloads,90350);
    assert.equal(before.rows.find((r:any)=>r.date==="2026-09-22").lifetimeDownloads,45523);
    const archive=await get("/api/demos/archive?search=graveyard&genre=Simulation");
    assert.equal(archive.total,1);assert.equal(archive.demos[0].downloads,45523);assert.equal(archive.demos[0].peak,19257);
    for(const sort of ["name","release","deactivated","downloads","reviews","peak"])
      for(const direction of ["asc","desc"])assert.equal((await get(`/api/demos/archive?sort=${sort}&direction=${direction}`)).total,1);
    assert.equal((await get("/api/demos/archive?search=absent")).total,0);
    assert.equal((await realFetch(base+"/api/demos/archive?offset=-1")).status,400);
    for(const window of ["d7","d30","d90","m12","ltd"]){
      const row=(await get(`/api/demos/leaderboard?window=${window}&search=5075680`)).demos[0];
      assert.equal(row.steamAppId,"5075680");assert.equal(row.isArchived,true);
      if(window==="d7")assert.equal(row.unitsMid,null,"stale rolling window cannot masquerade as current");
    }
    for(const sort of ["top","new"])
      assert.equal((await get(`/api/demos/leaderboard?sort=${sort}&search=5075680`)).demos.length,0);
    const {runDemosReviewHistoryCollector}=await import("./runner");
    const {runDemosCcuCollector}=await import("./ccu");
    const {computeDemoWindowEstimates}=await import("./estimator");
    globalThis.fetch=async()=>Response.json({success:1,results:{rollup_type:"week",
      rollups:[{date:1789344000,recommendations_up:0,recommendations_down:0}],recent:[]}});
    const empty=await runDemosReviewHistoryCollector(0,new Set(["5075680"]));
    assert.equal(empty.failed,1);assert.deepEqual(empty.succeededAppIds,[]);
    computeDemoWindowEstimates(today,new Set(empty.succeededAppIds));
    assert.equal(db.prepare("SELECT recommendations_up+recommendations_down n FROM steam_review_history").get().n,695);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_window_estimates_daily WHERE as_of_date=?").get(today).n,0);
    globalThis.fetch=async()=>Response.json({response:{result:1,player_count:0}});
    const ccu=await runDemosCcuCollector(0,new Set(["5075680"]));
    assert.equal(ccu.succeeded,1,"retired own-App-ID CCU remains polled; measured zero is legitimate");
    globalThis.fetch=async()=>new Response("unavailable",{status:404});
    await runDemosCcuCollector(0,new Set(["5075680"]));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_ccu_snapshots").get().n,2,"404 never writes a fabricated zero");
    globalThis.fetch=async()=>Response.json({success:1,results:{rollup_type:"week",
      rollups:[{date:1789344000,recommendations_up:601,recommendations_down:95}],recent:[]}});
    const fresh=await runDemosReviewHistoryCollector(0,new Set(["5075680"]));
    assert.equal(fresh.ingested,1);
    assert.equal(computeDemoWindowEstimates(today,new Set(fresh.succeededAppIds)).rowsWritten,5);
    const after=await get("/api/demos/titles/5075680?days=all");
    assert.equal(after.latest.reviews,696);assert.equal(after.latest.ccu,0);assert.equal(after.latest.peak,19257);
    assert.equal(after.rows.find((r:any)=>r.date===today).totalReviews,696,"observations continue beyond retirement date");
    assert.equal(after.deactivatedAt,before.deactivatedAt);
    const baseline=db.prepare("SELECT deactivated_at FROM demo_titles WHERE id=?").get(id).deactivated_at;
    // Full orchestrator: unrelated identities must not become retired tracked
    // demos; existing retirement date survives repeated runs.
    globalThis.fetch=async input=>{
      const url=String(input);
      if(url.includes("/IStoreBrowseService/GetItems/")){
        const ids=JSON.parse(new URL(url).searchParams.get("input_json")!).ids;
        return Response.json({response:{store_items:ids.map((i:any)=>({id:i.appid,success:15,visible:false}))}});
      }
      if(url.includes("/appreviewhistogram/"))return Response.json({success:0});
      if(url.includes("/GetNumberOfCurrentPlayers/"))return Response.json({response:{result:1,player_count:0}});
      throw Error("Bounded fixture source unavailable");
    };
    const {runDemosDailyPipeline}=await import("./pipeline");
    const run=await runDemosDailyPipeline(0);
    assert.equal(run.reviewHistory.attempted,7,"six approved Saber + retired competitor");
    assert.equal(run.ccu.succeeded,7);assert.equal(run.estimates.rowsWritten,0);
    assert.equal(db.prepare("SELECT deactivated_at FROM demo_titles WHERE id=?").get(id).deactivated_at,baseline);
    const seedDates=db.prepare("SELECT steam_app_id,deactivated_at FROM demo_titles WHERE is_saber_published=1 ORDER BY steam_app_id").all();
    assert.equal(seedDates.find((r:any)=>r.steam_app_id==="4354730").deactivated_at,null,"unknown pre-existing retirement is not invented");
    assert.ok(seedDates.find((r:any)=>r.steam_app_id==="5184670").deactivated_at,"new takedown detection is dated");
    await runDemosDailyPipeline(0);
    assert.deepEqual(db.prepare("SELECT steam_app_id,deactivated_at FROM demo_titles WHERE is_saber_published=1 ORDER BY steam_app_id").all(),seedDates);
    // Authentication covers archive reads just like PDPs.
    const saved={mode:process.env.AUTH_MODE,secret:process.env.SABER_AUTH_JWT_SECRET};
    process.env.AUTH_MODE="saber";process.env.SABER_AUTH_JWT_SECRET="retirement-test-secret";
    try{
      await new Promise<void>(r=>server.close(r));
      const secured=express();secured.use((await import("../../saber-auth")).createSaberAuthMiddleware().middleware);
      (await import("../../routes-demo-detail")).registerDemoDetailRoutes(secured);
      server=secured.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
      assert.equal((await realFetch(`http://127.0.0.1:${server.address().port}/api/demos/archive`)).status,401);
    }finally{
      for(const [key,value] of Object.entries({AUTH_MODE:saved.mode,SABER_AUTH_JWT_SECRET:saved.secret}))
        if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  }finally{
    globalThis.fetch=realFetch;if(server)await new Promise<void>(r=>server.close(r));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
