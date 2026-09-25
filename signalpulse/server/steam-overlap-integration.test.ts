import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { planSteamLtdRepair, applySteamLtdRepair } from "./steam-ltd-overlap-repair";

test("real estimator consumes deduplicated history after repair and remains stable across every period",async()=>{
  const repo=process.cwd(),dir=mkdtempSync(join(tmpdir(),"steam-overlap-estimator-"));
  process.chdir(dir);
  let db:any;
  try{
    db=(await import("./storage")).rawSqlite;
    const day=new Date().toISOString().slice(0,10),stamp=new Date().toISOString();
    const epoch=Date.parse(day+"T00:00:00Z")/1000;
    const release=new Date((epoch-4*86400)*1000).toISOString().slice(0,10);
    db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
      VALUES(99999,'steam','99999','base','paid',4999,?,?)`).run(stamp,stamp);
    db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
      VALUES(99999,'Overlap integration','Overlap integration',?,?,?,?)`).run(release,release,stamp,stamp);
    db.prepare(`INSERT INTO ownership_multipliers(platform,cohort_key,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at)
      VALUES('steam','default',40,.3,1,'test','test_model',?,?)`).run(release,stamp);
    const mid=db.prepare("SELECT id FROM ownership_multipliers WHERE platform='steam' ORDER BY id DESC LIMIT 1").get().id;
    db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,raw_json,created_at)
      VALUES(99999,'steam',?,'test',100,'ltd','{"rollup_type":"week"}',?)`).run(day,stamp);
    const bucket=db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('99999',?,?,?,0,'test',?)`);
    for(let i=0;i<5;i++)bucket.run(epoch-i*86400,"day",20,stamp);
    bucket.run(epoch-4*86400,"week",100,stamp);
    for(const w of ["ltd","d30"])db.prepare(`INSERT INTO window_estimates_daily
      (title_id,platform,window,as_of_date,signal_value,owners_mid,units_mid,multiplier_id,method,created_at)
      VALUES(99999,'steam',?,?,?,8000,8000,?,?,?)`).run(w,day,w==="ltd"?100:200,mid,
        w==="ltd"?"test_model+ltd_state:derived_max_windows":"test_model",stamp);
    db.prepare(`INSERT INTO title_ltd_state(title_id,platform,ltd_units,ltd_source,last_signal_value,last_updated_iso)
      VALUES(99999,'steam',8000,'derived_max_windows',100,?)`).run(stamp);
    const raw=JSON.stringify(db.prepare("SELECT * FROM steam_review_history").all());
    const plan=planSteamLtdRepair(db,day);
    assert.equal(plan.entries.find(e=>e.titleId===99999)?.after?.ltd_units,4000);
    applySteamLtdRepair(db,plan,"integration");
    const run=()=>execFileSync(resolve(repo,"node_modules/.bin/tsx"),
      ["--tsconfig",resolve(repo,"tsconfig.json"),resolve(repo,"scripts/estimate-console-units.ts")],
      {cwd:dir,env:{...process.env,LTD_ACCUMULATOR_ENABLED:"1"},timeout:30000,stdio:"pipe"});
    run();
    const rows=()=>db.prepare(`SELECT window,signal_value,units_mid,method,gated_reason FROM window_estimates_daily
      WHERE title_id=99999 AND as_of_date=? ORDER BY window`).all(day);
    const first=rows();
    assert.equal(first.length,5);
    for(const row of first){assert.equal(row.signal_value,100);assert.equal(row.units_mid,4000);assert.equal(row.gated_reason,null);}
    for(const row of first.filter((r:any)=>r.window!=="ltd"))assert.match(row.method,/steam_histogram_nonoverlap_v1/);
    run();assert.deepEqual(rows(),first);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM steam_review_history").all()),raw);
    // Unavailable or inconsistent input must not create a newly inflated window.
    db.prepare("UPDATE steam_review_history SET recommendations_up=999 WHERE bucket_granularity='day'").run();
    run();
    for(const row of rows().filter((r:any)=>r.window!=="ltd"))assert.equal(row.units_mid,null);
    assert.equal(rows().find((r:any)=>r.window==="ltd").units_mid,4000);
  }finally{db?.close();process.chdir(repo);rmSync(dir,{recursive:true,force:true});}
});
