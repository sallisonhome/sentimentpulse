import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { proposeDailyMix, DAILY_STEP, DAILY_MAX_DEVIATION, DAILY_MIX_VERSION, type DailyEvidence } from "./revenue-mix-daily-model";
import { runDailyMix, dailyMixMode, dailyMixStatus, ensureDailyMixSchema, publishedDailyAdjustments, applyDailyAdjustment, publishedDailyRevenue } from "./revenue-mix-daily";
import type { Mix } from "./revenue-mix-model";
const baseline:Mix=[.495,.379,.126];
const fixture=(key:string,today:Mix=[200,100,20],history:Mix[]=Array.from({length:14},()=>[200,100,20])):DailyEvidence =>
  ({key,cohort:"catalog:premium",baseline,today,history});
const peers=Array.from({length:20},(_,i)=>fixture(`peer-${i}`));
test("daily normal ratings retain baseline exactly",()=>{
  const r=proposeDailyMix(fixture("normal"),peers);
  assert.equal(r.reason,"within_norms");assert.deepEqual(r.candidate,baseline);
});
test("one-day moderate platform anomaly shifts subtly and normalized",()=>{
  const r=proposeDailyMix(fixture("sale-like",[200,200,20]),peers);
  assert.equal(r.reason,"daily_outlier");assert.ok(r.candidate[1]>baseline[1]);
  assert.ok(Math.abs(r.candidate.reduce((a,b)=>a+b,0)-1)<1e-12);
  assert.ok(r.candidate.every((n,i)=>Math.abs(n-baseline[i])<=DAILY_STEP+1e-12));
});
test("persistent over-indexing is learned without exponential compounding; normal resets",()=>{
  const e=fixture("persistent",[200,200,20],Array.from({length:14},()=>[200,200,20]));
  let prior=baseline;
  for(let d=0;d<200;d++){
    const next=proposeDailyMix(e,peers,prior).candidate;
    assert.ok(next.every((n,i)=>Math.abs(n-prior[i])<=DAILY_STEP+1e-12));
    assert.ok(next.every((n,i)=>Math.abs(n-baseline[i])<=DAILY_MAX_DEVIATION+1e-12));
    prior=next;
  }
  assert.deepEqual(proposeDailyMix(fixture("normal"),peers,prior).candidate,baseline);
});
test("cohort volume and platform review propensity do not manufacture shifts",()=>{
  assert.deepEqual(proposeDailyMix(fixture("twice",[400,200,40]),peers).candidate,baseline);
  const scale=(e:DailyEvidence):DailyEvidence=>({...e,today:e.today.map((n,i)=>n*[2,3,4][i]) as Mix,
    history:e.history.map(h=>h.map((n,i)=>n*[2,3,4][i]) as Mix)});
  const a=proposeDailyMix(fixture("outlier",[200,200,20]),peers);
  const b=proposeDailyMix(scale(fixture("outlier",[200,200,20])),peers.map(scale));
  a.candidate.forEach((n,i)=>assert.ok(Math.abs(n-b.candidate[i])<1e-12));
});
test("sparse history, invalid values, protected titles and batch spikes are rejected",()=>{
  for(const e of [
    {...fixture("protected"),blocked:"protected_family"},
    fixture("short",[200,200,20],[]),fixture("low",[2,2,1]),
    fixture("spike",[200,10000,20]),fixture("nan",[NaN,100,20]),
    fixture("negative",[200,-1,20]),
  ]) assert.deepEqual(proposeDailyMix(e,peers).candidate,baseline);
  assert.equal(proposeDailyMix(fixture("few"),peers.slice(0,9)).reason,"insufficient_cohort_peers");
});

const policy={familyKey:(s:string)=>s.toLowerCase(),protectedTitle:(s:string)=>s==="Protected",baseline,asp:[.66,.8,.8] as Mix};
function database(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO app_settings VALUES('revenue_mix_daily_mode','active');
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,is_gamepass,is_manual_override);
    CREATE TABLE console_title_igdb(title_id,name,store_name,match_confidence,release_date,store_release_date);
    CREATE TABLE xbox_title_cache(big_id,name,source);
    CREATE TABLE title_multiplier_overrides(title_id,effective_from);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,window_label);
    CREATE TABLE window_estimates_daily(title_id,platform,window,as_of_date,units_mid,method);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down);`);
  for(let f=0;f<12;f++){
    for(const [pi,p] of ["steam","ps5","xbox"].entries()){
      const id=f*3+pi,name=`Family ${f}`;
      db.prepare("INSERT INTO platform_sku_map VALUES(?,?,?,'base','paid',6000,0,0)").run(id,p,String(id));
      db.prepare("INSERT INTO console_title_igdb VALUES(?,?,?,'high','2020-01-01','2020-01-01')").run(id,name,name);
      if(p==="xbox") db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,'displaycatalog')").run(String(id),name);
      let count=10000;
      for(let d=0;d<=40;d++){
        const date=new Date(Date.parse("2026-09-01T00:00:00Z")+d*86400000).toISOString().slice(0,10);
        count+=pi===0?200:pi===1?(f===0?200:100):20;
        db.prepare("INSERT INTO store_rating_signal_daily VALUES(?,?,?,?,'ltd')").run(id,p,date,count);
        db.prepare("INSERT INTO window_estimates_daily VALUES(?,?,'ltd',?,?,'review:ltd_state:accumulator')").run(id,p,date,100000+d*1000);
      }
    }
  }
  ensureDailyMixSchema(db);ensureDailyMixSchema(db);
  return db;
}
test("daily ledger is idempotent, evidence-only writes, and supports immediate rollback",()=>{
  const db=database(),now=new Date("2026-09-21T12:00:00Z");
  const raw=JSON.stringify(db.prepare("SELECT * FROM window_estimates_daily").all());
  const ratings=JSON.stringify(db.prepare("SELECT * FROM store_rating_signal_daily").all());
  const run=runDailyMix(db,policy,now);
  assert.equal(run.adjusted,1);assert.equal(run.families,12);
  const first=db.prepare("SELECT * FROM revenue_mix_daily ORDER BY family_key").all();
  runDailyMix(db,policy,now);
  assert.deepEqual(db.prepare("SELECT * FROM revenue_mix_daily ORDER BY family_key").all(),first);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM window_estimates_daily").all()),raw);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM store_rating_signal_daily").all()),ratings);
  assert.equal(dailyMixStatus(db,now).applied,true);
  const m=publishedDailyAdjustments(db,policy,"d7",now);
  assert.equal(m.size,1);
  const a=m.get("family 0")!;
  assert.ok(a.delta[1]>0);assert.equal(a.delta[0],0);assert.equal(a.days,1);
  assert.equal(applyDailyAdjustment(500000,a,"ps5").revenue,500000+a.delta[1]);
  assert.equal(applyDailyAdjustment(1,a,"ps5").revenue,1,"incompatible windows fail closed");
  assert.equal(applyDailyAdjustment(100,a,"steam").revenue,100);
  const daily=publishedDailyRevenue(db,policy,"family 0","2026-09-01","2026-09-21",now);
  assert.equal(daily.get("2026-09-21")?.[1],a.baseline[1]+a.delta[1]);
  db.prepare("UPDATE app_settings SET value='off'").run();
  assert.equal(publishedDailyAdjustments(db,policy,"ltd",now).size,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revenue_mix_daily").get().n,12,"rollback keeps audit");
  db.prepare("UPDATE app_settings SET value='unknown'").run();assert.equal(dailyMixMode(db),"off");
  db.prepare("UPDATE app_settings SET value='active'").run();
  db.prepare("INSERT INTO app_settings VALUES('revenue_mix_mode','off')").run();assert.equal(dailyMixMode(db),"off");
  db.close();
});
test("a detected Steam review burst cannot train a daily platform-share shift",()=>{
  const db=database(),now=new Date("2026-09-21T12:00:00Z");
  const insert=db.prepare("INSERT INTO steam_review_history VALUES('0',?,'day',?,?)");
  const start=Date.parse("2026-08-24")/1000;
  for(let i=0;i<28;i++)insert.run(start+i*86400,50,10);
  insert.run(Date.parse("2026-09-21")/1000,100,17000);
  assert.equal(runDailyMix(db,policy,now).adjusted,0);
  const row=db.prepare("SELECT * FROM revenue_mix_daily WHERE family_key='family 0'").get() as any;
  assert.equal(JSON.parse(row.evidence_json).blocked,"review_activity_shock");
  assert.equal(row.applied,0);
  assert.deepEqual(JSON.parse(row.delta_json),[0,0,0]);
  db.close();
});
test("corrupt or out-of-bounds ledger rows are ignored rather than breaking reads",()=>{
  for(const sql of [
    "UPDATE revenue_mix_daily SET delta_json='not-json'",
    "UPDATE revenue_mix_daily SET delta_json='[0,1000000000,0]'",
    "UPDATE revenue_mix_daily SET result_json='{\"candidate\":[0.1,0.8,0.1],\"reason\":\"daily_outlier\"}'",
  ]){
    const db=database(),now=new Date("2026-09-21T12:00:00Z");runDailyMix(db,policy,now);db.exec(sql);
    assert.equal(publishedDailyAdjustments(db,policy,"d7",now).size,0);
    assert.equal(publishedDailyRevenue(db,policy,"family 0","2026-09-01","2026-09-21",now).size,0);
    db.close();
  }
});
test("windows sum only daily deltas in range; historical dates are never reallocated",()=>{
  const db=database();
  for(const day of [21,22,30]) runDailyMix(db,policy,new Date(`2026-09-${day}T12:00:00Z`));
  const now=new Date("2026-09-30T12:00:00Z");
  assert.equal(publishedDailyAdjustments(db,policy,"d7",now).get("family 0")?.days,1);
  for(const window of ["d30","d90","m12","ltd"]) assert.equal(publishedDailyAdjustments(db,policy,window,now).get("family 0")?.days,3);
  assert.equal(publishedDailyAdjustments(db,policy,"d7",new Date("2026-10-03T12:00:00Z")).size,0,"stale job falls back");
  assert.equal(db.prepare("SELECT MIN(date) d FROM revenue_mix_daily").get().d,"2026-09-21");
  db.close();
});
test("anchors, subscriptions, price changes and identity changes veto existing ledger at read time",()=>{
  for(const sql of [
    "INSERT INTO revenue_calibration_anchors VALUES(0)",
    "UPDATE platform_sku_map SET is_gamepass=1 WHERE title_id=1",
    "UPDATE platform_sku_map SET is_manual_override=1 WHERE title_id=1",
    "INSERT INTO title_multiplier_overrides VALUES(0,'2026-01-01')",
    "UPDATE platform_sku_map SET msrp_usd_cents=5000 WHERE title_id=1",
    "UPDATE console_title_igdb SET name='Different game',store_name='Different game' WHERE title_id=1",
    "UPDATE console_title_igdb SET release_date='2026-09-20',store_release_date='2026-09-20' WHERE title_id=1",
  ]){
    const db=database(),now=new Date("2026-09-21T12:00:00Z");runDailyMix(db,policy,now);
    db.exec(sql);assert.equal(publishedDailyAdjustments(db,policy,"d7",now).size,0,sql);db.close();
  }
});
test("mature ports can qualify despite historical staggered release dates",()=>{
  const db=database();
  db.exec("UPDATE console_title_igdb SET release_date='2016-01-01',store_release_date='2016-01-01' WHERE title_id=0");
  assert.equal(runDailyMix(db,policy,new Date("2026-09-21T12:00:00Z")).adjusted,1);
  db.close();
});
test("shadow evaluates without applying, and active does not retro-apply shadow days",()=>{
  const db=database(),now=new Date("2026-09-21T12:00:00Z");
  db.prepare("UPDATE app_settings SET value='shadow'").run();
  assert.equal(runDailyMix(db,policy,now).adjusted,0);
  const r=JSON.parse((db.prepare("SELECT result_json r FROM revenue_mix_daily WHERE family_key='family 0'").get() as any).r);
  assert.equal(r.reason,"daily_outlier");
  db.prepare("UPDATE app_settings SET value='active'").run();
  assert.equal(publishedDailyAdjustments(db,policy,"d7",now).size,0);
  runDailyMix(db,policy,new Date("2026-09-22T12:00:00Z"));
  assert.equal(publishedDailyAdjustments(db,policy,"d7",new Date("2026-09-22T12:00:00Z")).get("family 0")?.days,1);
  db.close();
});
test("missing snapshots, resets, revenue gaps and method changes never manufacture an adjustment",()=>{
  for(const sql of [
    "DELETE FROM store_rating_signal_daily WHERE title_id=1 AND capture_date='2026-09-20'",
    "UPDATE store_rating_signal_daily SET rating_count=1 WHERE title_id=1 AND capture_date='2026-09-21'",
    "DELETE FROM window_estimates_daily WHERE title_id=0 AND as_of_date='2026-09-20'",
    "UPDATE window_estimates_daily SET units_mid=999999999 WHERE title_id=0 AND as_of_date='2026-09-21'",
    "UPDATE window_estimates_daily SET method='bootstrap' WHERE title_id=0 AND as_of_date='2026-09-20'",
  ]){
    const db=database();db.exec(sql);
    assert.equal(runDailyMix(db,policy,new Date("2026-09-21T12:00:00Z")).adjusted,0,sql);db.close();
  }
});
