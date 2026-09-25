import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileSync} from "node:child_process";

test("real seeder ignores corrected historical snapshots; real daily writer ignores review rebounds",async()=>{
  const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),"ltd-high-water-"));
  process.chdir(dir);let db:any;
  try {
    db=(await import("./storage")).rawSqlite;
    const day=new Date().toISOString().slice(0,10),stamp=new Date().toISOString();
    const yesterday=new Date(Date.parse(day)-86400000).toISOString().slice(0,10);
    db.exec(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
      VALUES(99998,'steam','99998','base','paid',4999,'${stamp}','${stamp}');
      INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
      VALUES(99998,'Lifetime integration','Lifetime integration','2020-01-01','2020-01-01','${stamp}','${stamp}');
      INSERT INTO ownership_multipliers(platform,cohort_key,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at)
      VALUES('steam','default',40,.3,1,'test','test_model','2020-01-01','${stamp}');`);
    const mid=db.prepare("SELECT MAX(id) id FROM ownership_multipliers").get().id;
    db.exec(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
      VALUES(99997,'ps5','pace-fixture','base','paid',4999,'${stamp}','${stamp}');
      INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
      VALUES(99997,'Pace integration','Pace integration','2020-01-01','2020-01-01','${stamp}','${stamp}');
      INSERT INTO ownership_multipliers(platform,cohort_key,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at)
      VALUES('ps5','default',10,.3,1,'test','test_model','2020-01-01','${stamp}');`);
    const fourDaysAgo=new Date(Date.parse(day)-4*86400000).toISOString().slice(0,10);
    for(const [date,count] of [[fourDaysAgo,50],[day,500]]){
      db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,raw_json,created_at)
        VALUES(99997,'ps5',?,'test',?,'{}',?)`).run(date,count,stamp);
    }
    for(const [date,count] of [[yesterday,880801],[day,5003]]) {
      db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,raw_json,created_at)
        VALUES(99998,'steam',?,'test',?,'{"rollup_type":"week"}',?)`).run(date,count,stamp);
    }
    db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at)
      VALUES('99998',?,'week',5003,0,'test',?)`).run(Date.parse(day)/1000,stamp);
    db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,signal_value,owners_mid,units_mid,multiplier_id,method,created_at)
      VALUES(99998,'steam','ltd',?,5003,200120,200120,?,'test_model',?)`).run(day,mid,stamp);
    const run=(file:string)=>execFileSync(resolve(root,"node_modules/.bin/tsx"),
      ["--tsconfig",resolve(root,"tsconfig.json"),resolve(root,"scripts",file)],
      {cwd:dir,env:{...process.env,DB_PATH:join(dir,"data.db"),LTD_ACCUMULATOR_ENABLED:"1"},timeout:30000,stdio:"pipe"});
    const state=()=>db.prepare("SELECT * FROM title_ltd_state WHERE title_id=99998").get();
    run("seed-title-ltd-state.ts");
    assert.equal(state().ltd_units,200120);
    const original=state();run("seed-title-ltd-state.ts");assert.deepEqual(state(),original);
    for(const [count,units,water] of [[5003,200120,5003],[4990,200120,5003],[5003,200120,5003],[5010,200400,5010],[5010,200400,5010]]) {
      db.prepare("UPDATE store_rating_signal_daily SET rating_count=? WHERE title_id=99998 AND capture_date=?").run(count,day);
      db.prepare("UPDATE steam_review_history SET recommendations_up=? WHERE app_id='99998'").run(count);
      run("estimate-console-units.ts");
      assert.equal(state().ltd_units,units);
      assert.equal(state().last_signal_value,water);
      const pace=db.prepare("SELECT * FROM window_estimates_daily WHERE title_id=99997 AND window='m12' AND as_of_date=?").get(day);
      assert.equal(pace.signal_value,500);assert.equal(pace.units_mid,5000);
    }
    // An old persisted state (including one already operator-repaired) is not
    // modified even if a historical raw snapshot remains much larger.
    const repaired=state();run("seed-title-ltd-state.ts");assert.deepEqual(state(),repaired);
  }finally{db?.close();process.chdir(root);rmSync(dir,{recursive:true,force:true});}
});
