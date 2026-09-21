import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("active daily mix reaches every real route and units, and off restores baseline without deleting audit", async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"daily-mix-routes-"));
  process.chdir(dir);
  const fetchOriginal=globalThis.fetch;
  let server:any,db:any;
  try {
    db=(await import("./storage")).rawSqlite;
    const {registerConsoleLeaderboardRoutes,evaluateDailyRevenueMix}=await import("./routes-console-leaderboards");
    const date=new Date().toISOString().slice(0,10),stamp=new Date().toISOString();
    const mode=(value:string)=>db.prepare(`INSERT INTO app_settings(key,value,label,category,created_at,updated_at)
      VALUES('revenue_mix_daily_mode',?,'daily mix','general',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(value,stamp,stamp);
    mode("active");
    const platforms=["steam","ps5","xbox"];
    for(let f=0;f<12;f++){
      for(let pi=0;pi<3;pi++){
        const id=30000+f*3+pi,p=platforms[pi],name=`Daily QA Family ${f}`;
        db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
          VALUES(?,?,?,'base','paid',6000,?,?)`).run(id,p,String(id),stamp,stamp);
        db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,cover_url,refreshed_at,created_at)
          VALUES(?,?,?,'2020-01-01','2020-01-01','https://example.test/portrait.jpg',?,?)`).run(id,name,name,stamp,stamp);
        if(p==="xbox") db.prepare(`INSERT INTO xbox_title_cache(big_id,name,art_url,source,first_landed_at,last_verified_at)
          VALUES(?,?,'https://example.test/portrait.jpg','displaycatalog',?,?)`).run(String(id),name,stamp,stamp);
        let count=10000;
        for(let d=0;d<=40;d++){
          const day=new Date(Date.parse(date+"T00:00:00Z")-(40-d)*86400000).toISOString().slice(0,10);
          count+=pi===0?200:pi===1?(f===0&&d===40?200:100):20;
          db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
            VALUES(?,?,?,'qa',?,'ltd',?)`).run(id,p,day,count,stamp);
          db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,method,created_at)
            VALUES(?,?,'ltd',?,?,?,'review:ltd_state:accumulator',?)`).run(id,p,day,100000+d*1000,100000+d*1000,stamp);
        }
        for(const [window,units] of Object.entries({d7:7000,d30:30000,d90:60000,m12:100000})){
          db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,method,created_at)
            VALUES(?,?,?,?,?,?,'review_velocity',?)`).run(id,p,window,date,units,units,stamp);
        }
      }
    }
    const rawBefore=db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all();
    globalThis.fetch=async(input,init)=>{
      if(String(input).includes("api.steampowered.com"))return new Response(JSON.stringify({response:{store_items:[]}}));
      return fetchOriginal(input,init);
    };
    const app=express();registerConsoleLeaderboardRoutes(app);
    server=app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve=>server.once("listening",resolve));
    const get=async(path:string)=>{
      const r=await fetchOriginal(`http://127.0.0.1:${server.address().port}${path}`);
      const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body as any;
    };
    const evaluated=evaluateDailyRevenueMix();
    assert.equal(evaluated.adjusted,1);
    const key="daily qa family 0",familyPath=`/api/console/multiplatform-title/${encodeURIComponent(key)}`;
    const audit=JSON.parse(db.prepare("SELECT delta_json d FROM revenue_mix_daily WHERE family_key=?").get(key).d);
    for(const window of ["d7","d30","d90","m12","ltd"]){
      mode("off");
      const baseline=await get(`${familyPath}?window=${window}`);
      mode("active");
      const family=await get(`${familyPath}?window=${window}`);
      assert.equal(family.revenueSummary.calibration.mode,"active");
      assert.equal(family.perPlatform.steam.revenueUsd,baseline.perPlatform.steam.revenueUsd);
      for(let pi=0;pi<3;pi++){
        const platform=platforms[pi],f=family.perPlatform[platform],base=baseline.perPlatform[platform];
        assert.ok(Math.abs(f.revenueUsd-base.revenueUsd-audit[pi])<1e-7);
        assert.equal(f.unitsMid,Math.round(f.revenueUsd*100/f.aspUsdCents));
        const board=await get(`/api/console/leaderboards/${platform}?window=${window}`);
        const row=board.titles.find((r:any)=>r.editionGroupKey===key);
        assert.equal(row.unitsMid,f.unitsMid);assert.equal(row.revenueMidUsd,f.revenueUsd);
        const pdp=await get(`/api/console/titles/${30000+pi}?window=${window}`);
        assert.equal(pdp.windowKpisPerPlatform[0].revenueMidUsd,f.revenueUsd);
        assert.equal(pdp.windowKpisPerPlatform[0].unitsMid,f.unitsMid);
        if(Math.abs(audit[pi])>1e-8) assert.equal(row.dataSource,"derived_from_steam_daily_mix");
      }
      const multi=await get(`/api/console/leaderboards-multiplatform?window=${window}`);
      assert.equal(multi.titles.find((r:any)=>r.editionGroupKey===key).revenueCombined,family.combinedRevenueUsd);
    }
    const series=await get(`/api/console/titles/30000/revenue-daily?from=${date}&to=${date}`);
    const today=series.points.find((p:any)=>p.date===date);
    assert.equal(today.source,"daily_mix_ledger");
    const ledgerBase=JSON.parse(db.prepare("SELECT baseline_revenue_json b FROM revenue_mix_daily WHERE family_key=?").get(key).b);
    assert.equal(today.ps5,ledgerBase[1]+audit[1]);
    db.prepare("UPDATE xbox_title_cache SET art_url=NULL WHERE big_id='30002'").run();
    const noArt=await get("/api/console/leaderboards-multiplatform?window=d7");
    assert.deepEqual(noArt.titles.find((r:any)=>r.editionGroupKey===key).platforms,platforms);
    db.prepare("UPDATE platform_sku_map SET is_gamepass=1 WHERE title_id=30002").run();
    const protectedFamily=await get(`${familyPath}?window=d7`);
    assert.notEqual(protectedFamily.perPlatform.ps5.dataSource,"derived_from_steam_daily_mix");
    mode("off");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM revenue_mix_daily").get().n,12);
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(),rawBefore);
  } finally {
    globalThis.fetch=fetchOriginal;
    if(server)await new Promise<void>((resolve,reject)=>server.close((e:any)=>e?reject(e):resolve()));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
