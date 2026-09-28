import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import express from "express";
import {allocateMilestone,validateMilestone,installMilestone,refreshSteamUnitCalibration,
  milestoneProjection,activeMilestones} from "./steam-unit-calibration";
import {collectSteamSalesCcu,evaluateSteamSalesShadow,proposeSteamSalesAdjustment} from "./steam-sales-shadow";
const m=JSON.parse(readFileSync(new URL("../scripts/wardogs-milestone-2026-09-26.json",import.meta.url),"utf8"));

test("milestone preserves complete nonoverlapping daily shape and exact total",()=>{
  const rows=allocateMilestone(m);
  assert.equal(rows.reduce((s,w)=>s+w.units,0),3000000);
  assert.equal(validateMilestone(m).total,81240);
  for(const w of rows)assert.ok(Math.abs(w.units-w.signal*3000000/81240)<1);
  for(const bad of [{...m,weights:m.weights.slice(1)},
    {...m,weights:[m.weights[0],...m.weights.slice(0,-1)]},
    {...m,units:NaN},{...m,appId:"bad"}])assert.throws(()=>validateMilestone(bad));
});
test("shadow proposal uses independent baseline, bounded corroboration and never applies",()=>{
  const days=Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,1+i)).toISOString().slice(0,10),
    ccu:1000,reviews:i<7?200:100,minuteUtc:555}));
  const input={days,endDate:"2026-09-14",baseline:40,shock:false,protectedTitle:false,anchorCoefficient:null};
  const proposed=proposeSteamSalesAdjustment(input);
  assert.equal(proposed.proposedFactor,1.1);assert.equal(proposed.applied,false);
  assert.equal(proposed.proposedMultiplier,44);
  assert.equal(proposeSteamSalesAdjustment({...input,days:days.slice(1)}).proposedFactor,1);
  assert.equal(proposeSteamSalesAdjustment({...input,shock:true}).proposedFactor,1);
  assert.equal(proposeSteamSalesAdjustment({...input,protectedTitle:true}).proposedFactor,1);
  assert.equal(proposeSteamSalesAdjustment({...input,days:days.map(d=>({...d,reviews:200}))}).proposedFactor,1);
  assert.equal(proposeSteamSalesAdjustment({...input,days:days.map((d,i)=>({...d,minuteUtc:i?555:100}))}).proposedFactor,1);
});
test("real routes, writers, protection, no console propagation and rollback",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"steam-unit-calibration-"));
  process.chdir(dir);let db:any,server:any;
  try{
    db=(await import("./storage")).rawSqlite;
    const stamp="2026-09-27";
    for(const [id,p,sku,name] of [[10000,"steam","1867240","Wardogs"],[20000,"xbox","TESTXBOX","Wardogs"],
      [20001,"steam","999999","Control title"]] as const){
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',3999,?,?)`).run(id,p,sku,stamp,stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2026-09-10','2026-09-10',?,?)`).run(id,name,name,stamp,stamp);
      if(p==="xbox")db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,NULL,'displaycatalog',?,?,1)").run(sku,name,stamp,stamp);
      for(const w of ["d7","d30","d90","m12","ltd"])db.prepare(`INSERT INTO window_estimates_daily
        (title_id,platform,window,as_of_date,units_mid,owners_mid,signal_value,method,created_at)
        VALUES(?,?,?,?,?,?,?,'fixture',?)`).run(id,p,w,stamp,w==="d7"?251161:1555093,w==="d7"?251161:1555093,w==="d7"?13219:81847,stamp);
    }
    db.prepare(`INSERT INTO revenue_calibration_anchors(id,title_id,platform,window,as_of_date,actual_revenue_usd,
      actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
      VALUES(111,10000,'steam','ltd','2026-09-13',42229440,1600000,3999,'baseline','manual_anchor_publisher_disclosed',?)`).run(stamp);
    const putDay=(date:string,count:number)=>db.prepare(`INSERT INTO steam_review_history
      (app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('1867240',?,'day',?,0,'fixture',?) ON CONFLICT(app_id,bucket_start,bucket_granularity)
      DO UPDATE SET recommendations_up=excluded.recommendations_up`).run(Date.parse(date+"T00:00:00Z")/1000,count,stamp);
    for(const w of m.weights)putDay(w.date,w.signal);putDay(stamp,607);
    const frozenTables=["window_estimates_daily","title_ltd_state","revenue_calibration_anchors","title_multiplier_overrides"];
    const frozen=()=>Object.fromEntries(frozenTables.map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()]));
    const before=frozen();
    const {registerConsoleLeaderboardRoutes}=await import("./routes-console-leaderboards");
    const app=express();registerConsoleLeaderboardRoutes(app);server=app.listen(0,"127.0.0.1");
    await new Promise<void>(r=>server.once("listening",r));
    const get=async(path:string)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/console/${path}`);
      const body:any=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
    const baseline:any={};
    for(const w of ["d7","d30","d90","m12","ltd"])baseline[w]=await get(`multiplatform-title/wardogs?window=${w}`);
    installMilestone(db,m);refreshSteamUnitCalibration(db,stamp);
    const daily=db.prepare("SELECT * FROM steam_unit_calibration_daily ORDER BY date").all();
    installMilestone(db,m);refreshSteamUnitCalibration(db,stamp);
    assert.deepEqual(db.prepare("SELECT * FROM steam_unit_calibration_daily ORDER BY date").all(),daily);
    putDay(stamp,400);refreshSteamUnitCalibration(db,stamp);putDay(stamp,607);refreshSteamUnitCalibration(db,stamp);
    assert.deepEqual(db.prepare("SELECT units FROM steam_unit_calibration_daily ORDER BY date").all(),daily.map((d:any)=>({units:d.units})));
    const expected=milestoneProjection(db,m,"ltd",stamp)!.units;
    assert.equal(expected,3000000+Math.round(607*3000000/81240));
    for(const w of ["d7","d30","d90","m12","ltd"]){
      const f=await get(`multiplatform-title/wardogs?window=${w}`);
      assert.deepEqual(f.perPlatform.xbox,baseline[w].perPlatform.xbox,"Steam-only calibration does not touch console math");
      const b=(await get(`leaderboards/steam?window=${w}`)).titles.find((r:any)=>r.titleId===10000);
      const p=(await get(`titles/10000?window=${w}`)).windowKpisPerPlatform[0];
      const c=(await get(`leaderboards-multiplatform?window=${w}`)).titles.find((r:any)=>r.editionGroupKey==="wardogs");
      const units=milestoneProjection(db,m,w,stamp)!.units;
      assert.equal(b.unitsMid,units);assert.equal(p.unitsMid,units);assert.equal(f.perPlatform.steam.unitsMid,units);
      assert.equal(b.revenueMidUsd,p.revenueMidUsd);assert.equal(b.revenueMidUsd,f.perPlatform.steam.revenueUsd);
      assert.equal(c.revenueCombined,f.combinedRevenueUsd);assert.equal(b.dataSource,"estimated_public_unit_milestone");
      assert.ok(b.revenueCaveat.includes("Revenue and individual-day sales were not reported"));
      assert.equal(b.windowUsed,w);
      assert.equal(p.asOfDate,b.asOfDate);
      assert.equal(p.method,b.estimateMethod);
      assert.equal(p.unitMilestone.sourceUrl,m.sourceUrl);
      assert.equal(f.perPlatform.steam.asOfDate,b.asOfDate);
    }
    const chart=await get("titles/10000/revenue-daily?from=2026-09-10&to=2026-09-27");
    assert.ok(Math.abs(chart.points.reduce((s:number,p:any)=>s+(p.steam??0),0)-expected!*39.99*.66)<.01);
    assert.ok(chart.points.find((p:any)=>p.date==="2026-09-26").steam<3000000);
    assert.deepEqual(frozen(),before,"read-only layer and shadow leave all legacy sales tables alone");
    const observed=await collectSteamSalesCcu(db,(async()=>new Response(JSON.stringify({response:{ranks:[
      {appid:1867240,rank:3,concurrent_in_game:219592}]}}))) as typeof fetch,new Date("2026-09-27T09:15:00Z"));
    assert.equal(observed.count,1);
    await collectSteamSalesCcu(db,(async()=>{throw Error("must not fetch twice");}) as any,new Date("2026-09-27T10:15:00Z"));
    evaluateSteamSalesShadow(db,stamp);evaluateSteamSalesShadow(db,stamp);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM steam_sales_shadow_daily").get().n,2);
    assert.deepEqual(frozen(),before);
    assert.equal(JSON.parse(db.prepare("SELECT evidence_json FROM steam_sales_shadow_daily WHERE app_id='1867240'").get().evidence_json).applied,false);
    process.env.STEAM_UNIT_CALIBRATION_ENABLED="0";
    for(const w of Object.keys(baseline))assert.deepEqual(await get(`multiplatform-title/wardogs?window=${w}`),baseline[w]);
    delete process.env.STEAM_UNIT_CALIBRATION_ENABLED;
    db.prepare("UPDATE steam_unit_milestones SET active=0").run();
    assert.equal(activeMilestones(db).length,0);
    for(const w of Object.keys(baseline))assert.deepEqual(await get(`multiplatform-title/wardogs?window=${w}`),baseline[w]);
    installMilestone(db,m);
    db.prepare(`INSERT INTO title_multiplier_overrides
      (title_id,platform,effective_from,multiplier,ci_pct,digital_unit_share,confidence,method,created_at)
      VALUES(10000,'steam','2026-09-28',50,0.9,1,'high','new_verified_override',?)`).run(stamp);
    assert.notEqual((await get("titles/10000?window=ltd")).windowKpisPerPlatform[0].dataSource,"estimated_public_unit_milestone");
    db.prepare("DELETE FROM title_multiplier_overrides WHERE method='new_verified_override'").run();
    db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,
      actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
      VALUES(10000,'steam','d7','2026-09-28',12345,500,3999,'baseline','portal_fetch',?)`).run(stamp);
    assert.equal((await get("titles/10000?window=d7")).windowKpisPerPlatform[0].revenueMidUsd,12345);
    // Restore actual Wardogs platform scope: never synthesize a console.
    db.prepare("DELETE FROM platform_sku_map WHERE platform='xbox'").run();
    const onlySteam=await get("multiplatform-title/wardogs?window=ltd");
    assert.equal(onlySteam.perPlatform.xbox,undefined);
    assert.ok(!(await get("leaderboards-multiplatform?window=ltd")).titles.some((r:any)=>r.editionGroupKey==="wardogs"));
  }finally{
    delete process.env.STEAM_UNIT_CALIBRATION_ENABLED;
    if(server)await new Promise<void>(r=>server.close(()=>r()));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
