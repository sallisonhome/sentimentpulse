import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { proposeMix, type Evidence, type Mix } from "./revenue-mix-model";
import { ensureMixSchema, mixMode, runMixShadow } from "./revenue-mix-shadow";
import { steamPortraitFromItem } from "./console-portrait-art";
const baseline: Mix = [.495,.379,.126];
const fixture = (key: string, blocks: [Mix,Mix] = [[1000,500,100],[1000,500,100]]): Evidence => ({key,cohort:"catalog:premium",baseline,blocks});
const peers = Array.from({length:20},(_,i)=>fixture(`peer-${i}`));
test("normal titles retain baseline, not artificial diversity",()=>assert.deepEqual(proposeMix(fixture("normal"),peers).candidate,baseline));
test("sustained platform outlier makes capped normalized candidate",()=>{
  const r=proposeMix(fixture("outlier",[[1000,1500,100],[1000,1500,100]]),peers);
  assert.equal(r.reason,"shadow_candidate_only"); assert.ok(r.candidate[1]>baseline[1]);
  assert.ok(Math.abs(r.candidate.reduce((a,b)=>a+b,0)-1)<1e-12);
  assert.ok(r.candidate.every((n,i)=>Math.abs(n-baseline[i])<=.010000001));
  let prior=baseline;
  for(let d=0;d<100;d++) prior=proposeMix(fixture("outlier",[[1000,1500,100],[1000,1500,100]]),peers,prior).candidate;
  assert.ok(prior.every((n,i)=>Math.abs(n-baseline[i])<=.050000001));
});
test("one-block spikes, low samples, protected families, extreme outliers stay baseline",()=>{
  for (const e of [fixture("one",[[1000,1500,100],[1000,500,100]]),
    fixture("low",[[1000,500,1],[1000,500,1]]),
    {...fixture("manual"),blocked:"protected"},fixture("extreme",[[1000,50000,100],[1000,50000,100]])]) {
    assert.deepEqual(proposeMix(e,peers).candidate,baseline);
  }
  assert.equal(proposeMix(fixture("tiny"),peers.slice(0,3)).reason,"insufficient_cohort_peers");
});
test("cohort normalization cancels platform-specific review propensity",()=>{
  const scale=(e:Evidence):Evidence=>({...e,blocks:e.blocks.map(b=>[b[0]*10,b[1]*2,b[2]*3]) as [Mix,Mix]});
  const e=fixture("outlier",[[1000,1500,100],[1000,1500,100]]);
  const a=proposeMix(e,peers).candidate,b=proposeMix(scale(e),peers.map(scale)).candidate;
  a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-12));
});
test("additive migration twice and rollback mode fail closed",()=>{
  const db=new Database(":memory:"); db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT)");
  ensureMixSchema(db);ensureMixSchema(db);assert.equal(mixMode(db),"shadow");
  db.prepare("INSERT INTO app_settings VALUES('revenue_mix_mode','off')").run();
  assert.deepEqual(runMixShadow(db,s=>s,()=>false,baseline),{mode:"off",rows:0});
  db.prepare("UPDATE app_settings SET value='active'").run();assert.equal(mixMode(db),"off");
  db.close();
});
test("Steam portrait uses exact app identity and asset path, never header fallback",()=>{
  const item={appid:3219630,success:1,assets:{library_capsule:"hash/library_capsule.jpg",header:"header.jpg"}};
  assert.match(steamPortraitFromItem(item,"3219630")!,/3219630\/hash\/library_capsule.jpg$/);
  assert.equal(steamPortraitFromItem(item,"123"),null);
  assert.equal(steamPortraitFromItem({...item,assets:{header:"header.jpg"}},"3219630"),null);
  assert.equal(steamPortraitFromItem({...item,assets:{library_capsule:"../wrong.jpg"}},"3219630"),null);
});
test("daily collector covers five windows, preserves estimates and is idempotent",()=>{
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,is_gamepass,is_manual_override);
    CREATE TABLE console_title_igdb(title_id,name,store_name,match_confidence,release_date,store_release_date);
    CREATE TABLE xbox_title_cache(big_id,name,source);
    CREATE TABLE title_multiplier_overrides(title_id,effective_from);
    CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,window_label);
    CREATE TABLE window_estimates_daily(units_mid);
    INSERT INTO window_estimates_daily VALUES(123456);`);
  const now=new Date("2026-09-20T12:00:00Z");
  db.transaction(()=>{
    for(let f=0;f<12;f++) {
      for(const [pi,p] of Array.from(["steam","ps5","xbox"].entries())) {
        const id=f*3+pi,name=`Family ${f}`;
        db.prepare("INSERT INTO platform_sku_map VALUES(?,?,?,'base','paid',6000,0,0)").run(id,p,String(id));
        db.prepare("INSERT INTO console_title_igdb VALUES(?,?,?,'high','2020-01-01','2020-01-01')").run(id,name,name);
        if(p==="xbox") db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,'displaycatalog')").run(String(id),name);
        for(let d=0;d<=365;d++) {
          const date=new Date(now.getTime()-(365-d)*86400000).toISOString().slice(0,10);
          db.prepare("INSERT INTO store_rating_signal_daily VALUES(?,?,?,?,'ltd')").run(id,p,date,10000+d*(pi===0?200:pi===1?(f===0?300:100):20));
        }
      }
    }
  })();
  assert.equal(runMixShadow(db,s=>s,()=>false,baseline,now).rows,60);
  assert.equal((db.prepare("SELECT count(*) n FROM revenue_mix_shadow_daily").get() as any).n,60);
  const before=db.prepare("SELECT * FROM revenue_mix_shadow_daily ORDER BY family_key,window").all();
  runMixShadow(db,s=>s,()=>false,baseline,now);
  assert.deepEqual(db.prepare("SELECT * FROM revenue_mix_shadow_daily ORDER BY family_key,window").all(),before);
  assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(),[{units_mid:123456}]);
  const out=JSON.parse((db.prepare("SELECT result_json r FROM revenue_mix_shadow_daily WHERE family_key='Family 0' AND window='d7'").get() as any).r);
  assert.equal(out.reason,"shadow_candidate_only");
  db.prepare("DELETE FROM store_rating_signal_daily WHERE title_id=0 AND capture_date='2026-09-20'").run();
  runMixShadow(db,s=>s,()=>false,baseline,now);
  const blocked=JSON.parse((db.prepare("SELECT result_json r FROM revenue_mix_shadow_daily WHERE family_key='Family 0' AND window='d7'").get() as any).r);
  assert.equal(blocked.reason,"missing_or_stale_daily_history");
  db.close();
});
