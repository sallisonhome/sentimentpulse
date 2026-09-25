import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { planSteamLtdRepair, applySteamLtdRepair, rollbackSteamLtdRepair } from "./steam-ltd-overlap-repair";
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
    INSERT INTO title_ltd_state VALUES(1,'steam',8000,'derived_max_windows',100,'2026-09-24T09:00:00Z',NULL);
    INSERT INTO console_title_igdb VALUES(1,'Game','Game','2026-09-23','2026-09-23',NULL);
    INSERT INTO platform_sku_map VALUES(1,'steam','100','base','paid',0);
    INSERT INTO ownership_multipliers VALUES(1,'steam','default',40,1,'2026-09-01');
    INSERT INTO store_rating_signal_daily VALUES(1,'steam','2026-09-24',100,'{"rollup_type":"week"}');
    INSERT INTO window_estimates_daily VALUES(1,'steam','ltd','2026-09-24',8000,100,1,NULL,'calibrated+ltd_state:derived_max_windows');
    INSERT INTO window_estimates_daily VALUES(1,'steam','d30','2026-09-24',8000,200,1,NULL,'calibrated');
  `);
  const stamp=Date.parse("2026-09-23T00:00:00Z")/1000;
  const insert=db.prepare("INSERT INTO steam_review_history VALUES('100',?,?,?,0,'2026-09-24')");
  insert.run(stamp,"day",50);insert.run(stamp+86400,"day",50);insert.run(stamp,"week",100);
  return db;
}
test("dry run is read-only; apply is audited, idempotent and rollback restores exact original",()=>{
  const db=fixture(),before=db.serialize();
  const plan=planSteamLtdRepair(db,"2026-09-24");
  assert.deepEqual(db.serialize(),before);
  assert.equal(plan.entries[0].after?.ltd_units,4000);
  const raw=db.prepare("SELECT * FROM steam_review_history").all();
  const estimates=db.prepare("SELECT * FROM window_estimates_daily").all();
  assert.equal(applySteamLtdRepair(db,plan,"test").repaired,1);
  assert.equal(planSteamLtdRepair(db,"2026-09-24").entries.filter(e=>e.status==="repair").length,0);
  assert.deepEqual(db.prepare("SELECT * FROM steam_review_history").all(),raw);
  assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),estimates);
  assert.equal(rollbackSteamLtdRepair(db,"test").restored,1);
  assert.deepEqual(db.prepare("SELECT * FROM title_ltd_state").get(),plan.entries[0].before);
  db.close();
});
test("stale plan and rollback with intervening observations fail closed",()=>{
  const db=fixture(),plan=planSteamLtdRepair(db,"2026-09-24");
  db.exec("UPDATE title_ltd_state SET ltd_units=9000");
  assert.throws(()=>applySteamLtdRepair(db,plan,"stale"),/plan changed/);
  db.exec("UPDATE title_ltd_state SET ltd_units=8000");
  applySteamLtdRepair(db,plan,"test");
  db.exec("UPDATE title_ltd_state SET ltd_units=4500");
  assert.throws(()=>rollbackSteamLtdRepair(db,"test"),/State changed/);
  assert.equal((db.prepare("SELECT ltd_units FROM title_ltd_state").get() as any).ltd_units,4500);
  db.close();
});
for(const [name,sql] of [
  ["verified anchor","INSERT INTO revenue_calibration_anchors VALUES(1)"],
  ["manual multiplier","INSERT INTO title_multiplier_overrides VALUES(1)"],
  ["manual mapping","UPDATE platform_sku_map SET is_manual_override=1"],
  ["mature accumulator","UPDATE title_ltd_state SET ltd_source='accumulator'"],
  ["unknown provenance","UPDATE title_ltd_state SET ltd_units=9000"],
  ["missing historic coefficient","UPDATE window_estimates_daily SET multiplier_id=99"],
  ["mature release","UPDATE console_title_igdb SET release_date='2020-01-01'"],
  ["unreconciled reviews","UPDATE store_rating_signal_daily SET rating_count=105"],
])test(`repair preserves ${name}`,()=>{
  const db=fixture();db.exec(sql);const before=db.serialize();
  assert.equal(planSteamLtdRepair(db,"2026-09-24").entries[0].status,"skip");
  assert.deepEqual(db.serialize(),before);db.close();
});
test("historical review maxima survive resets but superseded coefficients do not become actuals",()=>{
  const db=fixture();
  db.exec(`INSERT INTO ownership_multipliers VALUES(2,'steam','default',60,1,'2026-08-01');
    INSERT INTO window_estimates_daily VALUES(1,'steam','ltd','2026-09-23',7200,120,2,NULL,'calibrated');`);
  assert.equal(planSteamLtdRepair(db,"2026-09-24").entries[0].after?.ltd_units,4800);
  db.close();
});
test("an unexplained old lifetime excess blocks the whole title",()=>{
  const db=fixture();
  db.exec(`INSERT INTO window_estimates_daily VALUES(1,'steam','ltd','2026-09-23',7900,90,1,NULL,'calibrated+ltd_state:derived_max_windows');`);
  assert.equal(planSteamLtdRepair(db,"2026-09-24").entries[0].reason,"unexplained_historical_lifetime_maximum");
  db.close();
});
