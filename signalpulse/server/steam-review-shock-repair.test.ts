import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {planReviewShockRepair,applyReviewShockRepair,rollbackReviewShockRepair} from "./steam-review-shock-repair";
function fixture(){
  const db=new Database(":memory:");
  db.exec(`
    CREATE TABLE title_ltd_state(title_id,platform,ltd_units,ltd_source,last_signal_value,last_updated_iso,seeded_from);
    CREATE TABLE console_title_igdb(title_id,name,store_name,release_date,store_release_date,match_confidence);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,is_manual_override);
    CREATE TABLE ownership_multipliers(id,platform,cohort_key,multiplier,digital_unit_share,effective_from);
    CREATE TABLE title_multiplier_overrides(title_id);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,raw_json);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,created_at);
    CREATE TABLE window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,multiplier_id,gated_reason,method);
    INSERT INTO title_ltd_state VALUES(1,'steam',1078880,'accumulator',18720,'2026-09-24T09:00:00Z',NULL);
    INSERT INTO console_title_igdb VALUES(1,'Established game','Established game','2016-01-01','2016-01-01',NULL);
    INSERT INTO platform_sku_map VALUES(1,'steam','100','base','paid',0);
    INSERT INTO ownership_multipliers VALUES(1,'steam','default',40,1,'2026-09-01');
    INSERT INTO store_rating_signal_daily VALUES(1,'steam','2026-09-24',18720,'{}');
    INSERT INTO window_estimates_daily VALUES(1,'steam','ltd','2026-09-22',394880,1620,1,NULL,'model+ltd_state:accumulator');
    INSERT INTO window_estimates_daily VALUES(1,'steam','ltd','2026-09-24',1078880,18720,1,NULL,'model+ltd_state:accumulator');
  `);
  const insert=db.prepare("INSERT INTO steam_review_history VALUES('100',?,'day',?,?, '2026-09-24')");
  const start=Date.parse("2026-08-27")/1000;
  for(let i=0;i<27;i++)insert.run(start+i*86400,50,10);
  insert.run(start+27*86400,100,17000);
  return db;
}
test("only proven incremental inflation is repaired, audited and exactly reversible",()=>{
  const db=fixture(),before=db.serialize(),plan=planReviewShockRepair(db,"2026-09-24");
  assert.deepEqual(db.serialize(),before);
  assert.equal(plan.entries[0].after?.ltd_units,399680);
  assert.equal(plan.entries[0].after?.last_signal_value,1740);
  const raw=db.prepare("SELECT * FROM steam_review_history").all();
  const history=db.prepare("SELECT * FROM window_estimates_daily").all();
  assert.equal(applyReviewShockRepair(db,plan,"test").repaired,1);
  assert.equal(planReviewShockRepair(db,"2026-09-24").entries[0].status,"skip");
  assert.deepEqual(db.prepare("SELECT * FROM steam_review_history").all(),raw);
  assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),history);
  assert.equal(rollbackReviewShockRepair(db,"test").restored,1);
  assert.deepEqual(db.prepare("SELECT * FROM title_ltd_state").get(),plan.entries[0].before);
  db.close();
});
test("stale or tampered manifests and rollback after subsequent writes fail closed",()=>{
  const db=fixture(),plan=planReviewShockRepair(db,"2026-09-24");
  const tampered=structuredClone(plan);tampered.entries[0].after!.ltd_units=1;
  assert.throws(()=>applyReviewShockRepair(db,tampered,"tampered"),/plan changed/);
  db.exec("UPDATE title_ltd_state SET ltd_units=1078881");
  assert.throws(()=>applyReviewShockRepair(db,plan,"stale"),/plan changed/);
  db.exec("UPDATE title_ltd_state SET ltd_units=1078880");
  applyReviewShockRepair(db,plan,"test");
  db.exec("UPDATE title_ltd_state SET ltd_units=399681");
  assert.throws(()=>rollbackReviewShockRepair(db,"test"),/Intervening state write/);
  assert.equal((db.prepare("SELECT ltd_units FROM title_ltd_state").get() as any).ltd_units,399681);
  db.close();
});
for(const [name,sql] of [
  ["anchor","INSERT INTO revenue_calibration_anchors VALUES(1)"],
  ["override","INSERT INTO title_multiplier_overrides VALUES(1)"],
  ["manual mapping","UPDATE platform_sku_map SET is_manual_override=1"],
  ["unknown provenance","UPDATE title_ltd_state SET ltd_units=1078881"],
  ["young derived state","UPDATE title_ltd_state SET ltd_source='derived_max_windows'"],
  ["changed coefficient","INSERT INTO ownership_multipliers VALUES(2,'steam','default',50,1,'2026-09-23')"],
  ["unreconciled histogram","UPDATE store_rating_signal_daily SET rating_count=19000"],
  ["unexplained old state","UPDATE window_estimates_daily SET units_mid=1 WHERE as_of_date='2026-09-22'"],
  ["missing pre-event state","DELETE FROM window_estimates_daily WHERE as_of_date='2026-09-22'"],
  ["stale snapshot","UPDATE store_rating_signal_daily SET capture_date='2026-09-01'"],
])test(`repair preserves ${name}`,()=>{
  const db=fixture();db.exec(sql);const before=db.serialize();
  assert.equal(planReviewShockRepair(db,"2026-09-24").entries[0].status,"skip");
  assert.deepEqual(db.serialize(),before);db.close();
});
