import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {allocateNestedDays,reconstructLaunchDaily} from "./launch-daily-reconstruction";

const factor=40.2005576061901, options={steamFactor:.66,ps5Factor:.8,ps5Ratio:37.9/49.5};
function fixture() {
  const db=new Database(":memory:");
  db.exec(`
    CREATE TABLE app_settings(key,value);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,is_manual_override,is_gamepass,msrp_usd_cents);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE title_multiplier_overrides(title_id);
    CREATE TABLE steam_unit_milestones(title_id,active);
    CREATE TABLE revenue_mix_daily(family_key,applied);
    CREATE TABLE window_estimates_daily(title_id,platform,window,as_of_date,signal_value,units_mid,gated_reason,multiplier_id,method,created_at);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count);
    CREATE TABLE ownership_multipliers(id,platform,multiplier,digital_unit_share);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down);
    INSERT INTO platform_sku_map VALUES(10175,'steam','1636440','base','paid',0,0,4999),
      (10774,'ps5','JP0101-PPSA33286_00-TOWNFALLSIEJ0000','base','paid',0,0,4999);
  `);
  db.prepare("INSERT INTO ownership_multipliers VALUES(14,'steam',?,1)").run(factor);
  [346,302,432,354,313,302,232,65].forEach((n,i)=>db.prepare("INSERT INTO steam_review_history VALUES('1636440',?,'day',?,0)")
    .run(Date.parse(`2026-09-${22+i}`)/1000,n));
  // Deliberately overlapping weekly evidence must not be added again.
  db.prepare("INSERT INTO steam_review_history VALUES('1636440',?,'week',2281,0)").run(Date.parse("2026-09-22")/1000);
  writeCurrent(db,"2026-09-29",2346,2000);
  return db;
}
function writeCurrent(db:Database.Database,date:string,total:number,weekly:number) {
  db.prepare("INSERT INTO store_rating_signal_daily VALUES(10175,'steam',?,?)").run(date,total);
  for(const w of ["d7","d30","d90","m12","ltd"]){
    const n=w==="d7"?weekly:total;
    db.prepare("INSERT INTO window_estimates_daily VALUES(10175,'steam',?,?,?,?,NULL,14,?,?)")
      .run(w,date,n,Math.round(n*factor),"calibrated_from_actuals_v1",date+"T09:25:00Z");
    db.prepare("INSERT INTO window_estimates_daily VALUES(10774,'ps5',?,?,?,70800,NULL,9,'backfill-bootstrap',?)")
      .run(w,date,n,date+"T09:25:00Z");
  }
}
const get=(db:Database.Database,from="2026-09-22",to="2026-09-29")=>
  reconstructLaunchDaily(db,"silent hill: townfall",from,to,options);
test("launch reconstruction restores date, conserves every nested period, no Xbox, read-only and repeatable",()=>{
 const db=fixture();
 try {
  const before=db.serialize(),r=get(db)!;
  assert.equal(r.points.length,8);
  const launch=r.points.find(r=>r.date==="2026-09-24")!;
  assert.equal(launch.reviewSignal,432);assert.ok(launch.steam!>570000);
  assert.equal(launch.xbox,null);assert.equal(launch.basis?.ps5,"modeled_platform_allocation");
  for(const [start,units] of [["2026-09-22",94311],["2026-09-23",80401]] as const){
    const days=r.points.filter(d=>d.date>=start);
    assert.equal(days.reduce((s,d)=>s+d.units!.steam,0),units);
    assert.ok(Math.abs(days.reduce((s,d)=>s+d.steam!,0)-units*32.9934)<1e-8);
    assert.ok(Math.abs(days.reduce((s,d)=>s+d.ps5!,0)-units*32.9934*options.ps5Ratio)<1e-8);
    assert.equal(days.reduce((s,d)=>s+d.units!.ps5,0),Math.round(units*32.9934*options.ps5Ratio/39.992));
  }
  assert.deepEqual(get(db),r);assert.deepEqual(db.serialize(),before);
  assert.deepEqual(get(db,"2026-09-24","2026-09-24")!.points,[launch]);
 } finally {db.close();}
});
test("new admitted daily evidence raises totals and units rather than freezing old figures",()=>{
 const db=fixture();
 try {
  const old=get(db)!;
  db.prepare("INSERT INTO steam_review_history VALUES('1636440',?,'day',500,0)").run(Date.parse("2026-09-30")/1000);
  writeCurrent(db,"2026-09-30",2846,2198);
  const r=get(db,"2026-09-22","2026-09-30")!;
  const units=r.points.reduce((s,d)=>s+d.units!.steam,0);
  assert.equal(units,Math.round(2846*factor));
  assert.ok(units>old.points.reduce((s,d)=>s+d.units!.steam,0));
  assert.equal(r.points.find(r=>r.date==="2026-09-30")?.reviewSignal,500);
  assert.deepEqual(get(db,"2026-09-22","2026-09-30"),r);
 } finally {db.close();}
});
for(const [name,sql] of [
 ["missing daily bucket","DELETE FROM steam_review_history WHERE bucket_granularity='day' AND recommendations_up=432"],
 ["stale window","UPDATE window_estimates_daily SET signal_value=0 WHERE window='d7' AND platform='steam'"],
 ["inflated lifetime seed","UPDATE window_estimates_daily SET units_mid=9999999 WHERE window='ltd' AND platform='steam'"],
 ["anchor","INSERT INTO revenue_calibration_anchors VALUES(10175)"],
 ["override","INSERT INTO title_multiplier_overrides VALUES(10774)"],
 ["milestone","INSERT INTO steam_unit_milestones VALUES(10175,1)"],
 ["daily mix","INSERT INTO revenue_mix_daily VALUES('silent hill: townfall',1)"],
 ["manual","UPDATE platform_sku_map SET is_manual_override=1 WHERE platform='ps5'"],
 ["game pass","UPDATE platform_sku_map SET is_gamepass=1 WHERE platform='ps5'"],
 ["missing console","DELETE FROM platform_sku_map WHERE platform='ps5'"],
 ["conflicting app","INSERT INTO platform_sku_map VALUES(999,'steam','1636440','base','paid',0,0,4999)"],
 ["bad price","UPDATE platform_sku_map SET msrp_usd_cents=NULL WHERE platform='steam'"],
 ["kill switch","INSERT INTO app_settings VALUES('launch_daily_reconstruction_enabled','0')"],
 ["weekly unavailable","UPDATE window_estimates_daily SET gated_reason='insufficient_history' WHERE window='d7' AND platform='ps5'"],
 ["negative evidence","UPDATE steam_review_history SET recommendations_down=-1"],
] as const) test(`fail closed: ${name}`,()=>{
 const db=fixture();try{db.exec(sql);assert.equal(get(db),null);}finally{db.close();}
});
test("other titles, invalid dates, future days and malformed constraints",()=>{
 const db=fixture();
 try{
  assert.equal(reconstructLaunchDaily(db,"wardogs","2026-09-22","2026-09-29",options),null);
  assert.equal(get(db,"2026-02-31"),null);
  assert.equal(get(db,"2026-09-22","2026-10-01")!.points.at(-1)?.date,"2026-09-29");
  assert.equal(allocateNestedDays([{date:"2026-09-24",signal:0}],[{start:"2026-09-24",units:100}]),null);
 }finally{db.close();}
});
