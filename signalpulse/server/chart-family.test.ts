import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {chartFamilyKey,canonicalSiblings} from "./chart-family";
import {editionGroupKey} from "./console-sales-family";

test("Space Marine 2 Xbox spelling bridges to the Steam/PS5 key for the chart only",()=>{
  const xbox=editionGroupKey("Warhammer 40,000: Space Marine 2"),ps5=editionGroupKey("Warhammer 40,000: Space Marine II");
  assert.notEqual(xbox,ps5);                       // board join (and every overlay) is unchanged
  assert.equal(chartFamilyKey(xbox),chartFamilyKey(ps5));
  assert.equal(chartFamilyKey(editionGroupKey("Hades 2")),editionGroupKey("Hades 2"));
  assert.equal(chartFamilyKey(editionGroupKey("Space Marine 2")),"space marine 2");
});
function fixture(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE platform_sku_map(title_id,platform,sku_role,msrp_usd_cents);
    CREATE TABLE window_estimates_daily(title_id,platform,window,as_of_date,units_mid);
    INSERT INTO platform_sku_map VALUES(10387,'ps5','base',NULL),(10400,'ps5','base',5999),(10029,'steam','base',5999),(10948,'xbox','base',6999);`);
  for(const d of["2026-10-01","2026-10-02"])for(const [id,p] of [[10387,"ps5"],[10400,"ps5"],[10029,"steam"],[10948,"xbox"]] as const)
    db.prepare("INSERT INTO window_estimates_daily VALUES(?,?,'ltd',?,100)").run(id,p,d);
  return db;
}
const ids=[10029,10387,10400,10948].map(t=>({titleId:t,platform:t===10029?"steam":t===10948?"xbox":"ps5"}));
test("one title per platform: the priced PS5 listing wins, the others pass through",()=>{
  const db=fixture();
  try{
    assert.deepEqual(canonicalSiblings(db,ids,10387).sort(),[10029,10400,10948]);
    assert.deepEqual(canonicalSiblings(db,ids,10400).sort(),[10029,10400,10948]);
    assert.deepEqual(canonicalSiblings(db,ids.filter(i=>i.titleId!==10387),10029).sort(),[10029,10400,10948]);
  }finally{db.close();}
});
test("listings that disagree on a shared day are a real conflict: both priced listings stay (the route sums them)",()=>{
  const db=fixture();
  try{
    db.exec("UPDATE platform_sku_map SET msrp_usd_cents=5999 WHERE title_id=10387");
    db.exec("UPDATE window_estimates_daily SET units_mid=250 WHERE title_id=10387 AND as_of_date='2026-10-02'");
    assert.deepEqual(canonicalSiblings(db,ids,10400).sort(),[10029,10387,10400,10948]);
    db.exec("DELETE FROM window_estimates_daily WHERE title_id=10387");
    assert.deepEqual(canonicalSiblings(db,ids,10400).sort(),[10029,10387,10400,10948]); // no shared valued day
  }finally{db.close();}
});
test("without prices the title with more native estimates wins, then the requested id, then lowest id",()=>{
  const db=fixture();
  try{
    db.exec("UPDATE platform_sku_map SET msrp_usd_cents=5999 WHERE title_id=10387");
    assert.ok(canonicalSiblings(db,ids,10400).includes(10400));
    db.prepare("INSERT INTO window_estimates_daily VALUES(10387,'ps5','ltd','2026-10-03',100)").run();
    assert.ok(canonicalSiblings(db,ids,10400).includes(10387));
    assert.equal(canonicalSiblings(db,ids,10400).length,3);
  }finally{db.close();}
});
