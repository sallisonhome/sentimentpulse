import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {planLifetimeCatalogRepair,applyLifetimeCatalogRepair,rollbackLifetimeCatalogRepair} from "./lifetime-catalog-repair";
import {planLifetimeWindowFloorRepair} from "./lifetime-window-floor-repair";

function fixture(){
  const db=new Database(":memory:");
  db.exec(`
    CREATE TABLE title_ltd_state(title_id,platform,ltd_units,ltd_source,last_signal_value,last_updated_iso,seeded_from);
    CREATE TABLE console_title_igdb(title_id,name,store_name,release_date,store_release_date,match_confidence);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,is_manual_override);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE title_multiplier_overrides(title_id);
    CREATE TABLE ownership_multipliers(id,platform,cohort_key,multiplier,digital_unit_share,effective_from);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,raw_json);
    CREATE TABLE steam_review_history(app_id);
    CREATE TABLE window_estimates_daily(id INTEGER PRIMARY KEY,title_id,platform,window,as_of_date,
      signal_value,units_mid,owners_mid,owners_low,owners_high,multiplier_id,gated_reason,method,created_at);
    INSERT INTO title_ltd_state VALUES(77,'ps5',50000,'derived_max_windows',120,'old','option_b_replay_2026_09_15');
    INSERT INTO console_title_igdb VALUES(77,'Example','Example','2026-01-01','2026-01-01','high');
    INSERT INTO platform_sku_map VALUES(77,'ps5','sku','base','paid',0);
    INSERT INTO ownership_multipliers VALUES(9,'ps5','default',10,1,'2020-01-01');
    INSERT INTO store_rating_signal_daily VALUES(77,'ps5','2026-09-25',120,'{}');`);
  for(const [date,signal,windowSignal] of [["2026-09-15",100,5000],["2026-09-25",120,3000]] as const){
    db.prepare(`INSERT INTO window_estimates_daily VALUES(NULL,77,'ps5','ltd',?,?,50000,50000,35000,65000,9,NULL,'model+ltd_state:derived_max_windows','old')`).run(date,signal);
    db.prepare(`INSERT INTO window_estimates_daily VALUES(NULL,77,'ps5','m12',?,?,?,?,?,?,9,NULL,'backfill-observed-pace','old')`).run(date,windowSignal,windowSignal*10,windowSignal*10,windowSignal*7,windowSignal*13);
  }
  return db;
}
test("catalog exact replay repairs impossible console windows, persists history, and rolls back exactly",()=>{
  const db=fixture();try{
    const beforeState=db.prepare("SELECT * FROM title_ltd_state").all(),beforeEst=db.prepare("SELECT * FROM window_estimates_daily").all();
    const p=planLifetimeCatalogRepair(db,"2026-09-25");
    assert.equal(p.audit.stateCount,1);assert.equal(p.entries.length,1);assert.equal(p.entries[0].after.ltd_units,1200);
    assert.deepEqual(db.prepare("SELECT * FROM title_ltd_state").all(),beforeState);
    assert.equal(applyLifetimeCatalogRepair(db,p,"test").historicalRows,2);
    assert.equal((db.prepare("SELECT ltd_units FROM title_ltd_state").get() as any).ltd_units,1200);
    assert.throws(()=>applyLifetimeCatalogRepair(db,p,"again"),/changed/);
    rollbackLifetimeCatalogRepair(db,"test");
    assert.deepEqual(db.prepare("SELECT * FROM title_ltd_state").all(),beforeState);
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),beforeEst);
  }finally{db.close();}
});
for(const [name,sql] of [
  ["anchors","INSERT INTO revenue_calibration_anchors VALUES(77)"],
  ["overrides","INSERT INTO title_multiplier_overrides VALUES(77)"],
  ["manual identity","UPDATE platform_sku_map SET is_manual_override=1"],
  ["unexplained units","UPDATE window_estimates_daily SET units_mid=51000 WHERE window='ltd'"],
  ["unknown coefficient","UPDATE window_estimates_daily SET multiplier_id=99 WHERE window='ltd'"],
  ["stale signal","UPDATE store_rating_signal_daily SET capture_date='2026-09-10'"],
  ["rank floor","UPDATE window_estimates_daily SET method='rank_anchor:psn_api_sales30' WHERE window='m12'"],
]){
  test(`catalog repair preserves ${name}`,()=>{const db=fixture();try{db.exec(sql);assert.equal(planLifetimeCatalogRepair(db,"2026-09-25").entries.length,0);}finally{db.close();}});
}
test("catalog manifest tamper/staleness and rollback conflicts fail closed",()=>{
  const db=fixture();try{
    const p=planLifetimeCatalogRepair(db,"2026-09-25"),bad=structuredClone(p);bad.entries[0].after.ltd_units=1;
    assert.throws(()=>applyLifetimeCatalogRepair(db,bad,"bad"),/changed/);
    applyLifetimeCatalogRepair(db,p,"good");
    db.exec("UPDATE window_estimates_daily SET created_at='intervening' WHERE window='ltd'");
    assert.throws(()=>rollbackLifetimeCatalogRepair(db,"good"),/Intervening estimate/);
  }finally{db.close();}
});
test("a corrected count can decrease in derived state without erasing an earlier legitimate floor",()=>{
  const db=fixture();try{
    db.exec("UPDATE window_estimates_daily SET signal_value=90 WHERE window='ltd' AND as_of_date='2026-09-25';UPDATE store_rating_signal_daily SET rating_count=90;UPDATE title_ltd_state SET last_signal_value=90");
    const p=planLifetimeWindowFloorRepair(db,"2026-09-25");
    const e=p.entries.find(e=>e.status==="repair") as any;assert.equal(e.after.ltd_units,1000);
  }finally{db.close();}
});
