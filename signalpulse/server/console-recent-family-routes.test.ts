import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import express from "express";

test("rolling family correction is canonical, reversible, non-writing and protects long windows/actuals",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"fc26-routes-"));
  process.chdir(dir);let db:any,server:any;
  try{
    db=(await import("./storage")).rawSqlite;
    const {registerConsoleLeaderboardRoutes}=await import("./routes-console-leaderboards");
    const windows=["d7","d30","d90","m12","ltd"];
    for(const [id,p,sku,name] of [[11166,"steam","3405690","EA SPORTS FC™ 26"],
      [10328,"ps5","UP0006-PPSA27360_00-26STANDARDBUNDLE","EA SPORTS FC™ 26 Standard Edition PS4 & PS5"],
      [11078,"xbox","9P9FTXPKQ35P","EA SPORTS FC™ 26 Xbox Series X|S"],
      [10083,"steam","4080220","EA SPORTS FC™ 27"]] as const){
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',6999,'2026-09-26','2026-09-26')`).run(id,p,sku);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2025-09-26','2026-09-26','2026-09-26')`).run(id,name,name);
      if(p==="xbox")db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,NULL,'displaycatalog','2026-09-26','2026-09-26',1)").run(sku,name);
      for(const w of windows)db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,signal_value,method,created_at)
        VALUES(?,?,?,'2026-09-26',?,?,1000,'fixture','2026-09-26')`)
        .run(id,p,w,p==="steam"?162410:p==="ps5"?225726:50000,p==="steam"?162410:p==="ps5"?225726:50000);
    }
    const frozen=db.prepare("SELECT * FROM window_estimates_daily").all();
    const app=express();registerConsoleLeaderboardRoutes(app);server=app.listen(0,"127.0.0.1");
    await new Promise<void>(r=>server.once("listening",r));
    const get=async(path:string)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/console/${path}`);
      assert.equal(r.status,200);return r.json() as Promise<any>;};
    const family=(w:string)=>get(`multiplatform-title/ea%20sports%20fc%2026?window=${w}`);
    const baseline:any={};
    process.env.FC26_RECENT_FAMILY_ENABLED="0";
    for(const w of windows)baseline[w]=await family(w);
    const control=await get("leaderboards/steam?window=d30");
    delete process.env.FC26_RECENT_FAMILY_ENABLED;
    for(const w of windows){
      const f=await family(w);
      if(["m12","ltd"].includes(w)){assert.deepEqual(f,baseline[w]);continue;}
      const s=f.perPlatform.steam.revenueUsd;
      assert.ok(s<baseline[w].perPlatform.steam.revenueUsd);
      assert.ok(Math.abs(f.perPlatform.ps5.revenueUsd/s-6.5)<1e-10);
      assert.ok(Math.abs(f.perPlatform.xbox.revenueUsd/s-2.5)<1e-10);
      assert.equal(f.revenueSummary.incomplete,false);
      const combined=await get(`leaderboards-multiplatform?window=${w}`);
      const row=combined.titles.find((r:any)=>r.editionGroupKey==="ea sports fc 26");
      assert.equal(row.revenueCombined,f.combinedRevenueUsd);
      assert.equal(combined.titles.filter((r:any)=>r.editionGroupKey==="ea sports fc 26").length,1);
      for(const [p,id] of [["steam",11166],["ps5",10328],["xbox",11078]] as const){
        const board=await get(`leaderboards/${p}?window=${w}`),k=f.perPlatform[p];
        const row=board.titles.find((r:any)=>r.titleId===id);
        assert.equal(row.revenueMidUsd,k.revenueUsd);
        assert.equal(row.unitsMid,Math.round(k.revenueUsd*100/k.aspUsdCents));
        assert.ok(row.revenueCaveat);assert.equal(k.windowUsed,w);
        const pdp=await get(`titles/${id}?window=${w}`);
        assert.equal(pdp.windowKpisPerPlatform[0].revenueMidUsd,k.revenueUsd);
        assert.equal(pdp.windowKpisPerPlatform[0].revenueCaveat,k.revenueCaveat);
      }
    }
    assert.deepEqual((await get("leaderboards/steam?window=d30")).titles.find((r:any)=>r.titleId===10083),
      control.titles.find((r:any)=>r.titleId===10083));
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),frozen);
    const fc26BeforeFc27Spike=await family("d30");
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid*100,owners_mid=owners_mid*100 WHERE title_id=10083").run();
    assert.deepEqual(await family("d30"),fc26BeforeFc27Spike,"FC27 sales cannot leak into FC26");
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid/100,owners_mid=owners_mid/100 WHERE title_id=10083").run();
    process.env.FC26_RECENT_FAMILY_ENABLED="0";
    assert.deepEqual(await family("d30"),baseline.d30);
    delete process.env.FC26_RECENT_FAMILY_ENABLED;
    db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,
      actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
      VALUES(11166,'steam','d30','2026-09-26',123456,3000,6999,'regular','manual_anchor_verified_test','2026-09-26')`).run();
    assert.equal((await family("d30")).perPlatform.steam.revenueUsd,123456);
    assert.equal((await family("d30")).perPlatform.steam.unitsMid,3000);
    db.prepare("DELETE FROM revenue_calibration_anchors WHERE title_id=11166").run();
    db.prepare("UPDATE window_estimates_daily SET units_mid=NULL WHERE window='d30' AND title_id IN(11166,10328,11078)").run();
    const missing=await family("d30");
    for(const k of Object.values(missing.perPlatform) as any[]){
      assert.equal(k.revenueUsd,null);assert.equal(k.unitsMid,null);assert.equal(k.windowUsed,null);
    }
    assert.equal(missing.revenueSummary.incomplete,true);
  }finally{
    delete process.env.FC26_RECENT_FAMILY_ENABLED;
    if(server)await new Promise<void>(r=>server.close(()=>r()));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
