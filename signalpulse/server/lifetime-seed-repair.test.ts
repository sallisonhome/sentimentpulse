import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { advanceLifetimeSignal } from "./lifetime-signal";
import { planLifetimeSeedRepair, applyLifetimeSeedRepair, rollbackLifetimeSeedRepair } from "./lifetime-seed-repair";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE title_ltd_state(title_id,platform,ltd_units,ltd_source,last_signal_value,last_updated_iso,seeded_from);
    CREATE TABLE console_title_igdb(title_id,store_name,name);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,is_manual_override);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE title_multiplier_overrides(title_id);
    CREATE TABLE ownership_multipliers(id,platform,cohort_key,multiplier,digital_unit_share,effective_from);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,raw_json);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down);
    CREATE TABLE window_estimates_daily(id INTEGER PRIMARY KEY,title_id,platform,window,as_of_date,signal_value,units_mid,owners_mid,owners_low,owners_high,multiplier_id,gated_reason,method,created_at);
    INSERT INTO console_title_igdb VALUES(1,'Seed regression','Seed regression');
    INSERT INTO platform_sku_map VALUES(1,'steam','123','base','paid',0);
    INSERT INTO ownership_multipliers VALUES(14,'steam','default',40,1,'2026-09-01');
  `);
  const points: Array<[string, number]> = [["10",880801],["11",4824],["12",4833],["13",4850],["14",4878],["15",4898],["16",4902],["25",5003]];
  for (const [day,n] of points) db.prepare("INSERT INTO store_rating_signal_daily VALUES(1,'steam',?,?,?)")
    .run(`2026-09-${day}`,n,'{"rollup_type":"week"}');
  db.prepare("INSERT INTO steam_review_history VALUES('123',?,'week',5003,0)").run(Date.parse("2026-09-20")/1000);
  let id=0;
  for (const [day,n] of points.slice(1)) {
    const seeded = day >= "15", units = seeded ? (880801+n-4824)*40 : n*40;
    db.prepare("INSERT INTO window_estimates_daily VALUES(?,1,'steam','ltd',?,?,?,?,?,?,14,NULL,?,'original')")
      .run(++id,`2026-09-${day}`,n,units,units,units*.8,units*1.2,seeded?"model+ltd_state:accumulator":"model");
  }
  db.prepare("INSERT INTO title_ltd_state VALUES(1,'steam',?,'accumulator',5003,'original','option_b_replay_2026_09_15')")
    .run((880801+5003-4824)*40);
  return db;
}
test("cumulative high-water prevents dips, missing values and rebounds from counting twice",()=>{
  let high:number|null=100, total=0;
  for (const signal of [90,95,null,100,103,103]) {
    const next=advanceLifetimeSignal(signal,high);total+=next.delta;high=next.highWater;
  }
  assert.equal(total,3);assert.equal(high,103);
  assert.deepEqual(advanceLifetimeSignal(10,null),{delta:0,highWater:10});
  assert.deepEqual(advanceLifetimeSignal(NaN,10),{delta:0,highWater:10});
});
test("repair proves exact seed excess, corrects only LTD history and round-trips rollback",()=>{
  const db=fixture(),snap=db.serialize();
  const before=db.prepare("SELECT * FROM title_ltd_state").all();
  const history=db.prepare("SELECT * FROM window_estimates_daily").all();
  const plan=planLifetimeSeedRepair(db,"2026-09-25"),e=plan.entries[0];
  assert.equal(e.status,"repair");assert.ok("after" in e);assert.equal(e.after.ltd_units,5003*40);
  assert.deepEqual(db.serialize(),snap);
  assert.equal(applyLifetimeSeedRepair(db,plan,"test").repaired,1);
  assert.equal((db.prepare("SELECT ltd_units FROM title_ltd_state").get() as any).ltd_units,200120);
  assert.equal(planLifetimeSeedRepair(db,"2026-09-25").entries[0].status,"skip");
  assert.throws(()=>applyLifetimeSeedRepair(db,plan,"again"),/changed/);
  assert.equal(rollbackLifetimeSeedRepair(db,"test").restored,1);
  assert.deepEqual(db.prepare("SELECT * FROM title_ltd_state").all(),before);
  assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),history);
  db.close();
});
for (const [name,sql] of [
  ["anchor","INSERT INTO revenue_calibration_anchors VALUES(1)"],
  ["override","INSERT INTO title_multiplier_overrides VALUES(1)"],
  ["manual","UPDATE platform_sku_map SET is_manual_override=1"],
  ["identity","INSERT INTO platform_sku_map VALUES(1,'steam','456','base','paid',0)"],
  ["bad histogram","UPDATE steam_review_history SET recommendations_up=5004"],
  ["unexplained seed","UPDATE window_estimates_daily SET units_mid=units_mid+100 WHERE as_of_date='2026-09-15'"],
  ["unexplained growth","UPDATE window_estimates_daily SET units_mid=units_mid+100 WHERE as_of_date='2026-09-16'"],
  ["changed coefficient","INSERT INTO ownership_multipliers VALUES(15,'steam','default',41,1,'2026-09-20')"],
  ["unexplained state","UPDATE title_ltd_state SET ltd_units=ltd_units+100"],
  ["nonisolated snapshot","UPDATE store_rating_signal_daily SET rating_count=800000 WHERE capture_date='2026-09-12'"],
]) test(`repair refuses ${name}`,()=>{
  const db=fixture();db.exec(sql);
  assert.equal(planLifetimeSeedRepair(db,"2026-09-25").entries[0].status,"skip");db.close();
});
test("stale and tampered plans fail closed; rollback refuses intervening writes",()=>{
  const db=fixture(),plan=planLifetimeSeedRepair(db,"2026-09-25");
  const tampered=structuredClone(plan);tampered.asOf="2026-09-24";
  assert.throws(()=>applyLifetimeSeedRepair(db,tampered,"bad"),/changed/);
  db.exec("UPDATE title_ltd_state SET ltd_units=ltd_units+1");
  assert.throws(()=>applyLifetimeSeedRepair(db,plan,"stale"),/changed/);
  db.exec("UPDATE title_ltd_state SET ltd_units=ltd_units-1");
  applyLifetimeSeedRepair(db,plan,"good");
  db.exec("UPDATE window_estimates_daily SET units_mid=units_mid+1 WHERE as_of_date='2026-09-25'");
  assert.throws(()=>rollbackLifetimeSeedRepair(db,"good"),/Intervening estimate/);
  db.close();
});
