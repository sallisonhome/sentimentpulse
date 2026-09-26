import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {planSalesCoverage,applySalesCoverage,rollbackSalesCoverage,loadSalesCatalog} from "./sales-catalog-reconcile";
import {steamSaleEvidence} from "./sales-catalog-eligibility";

const now=new Date("2026-09-26T12:00:00Z");
function native(sku:string,name:string,patch:Record<string,unknown>={}){
  return {[sku]:{success:true,data:{steam_appid:Number(sku),name,type:"game",is_free:false,
    price_overview:{initial:2999,currency:"USD"},release_date:{coming_soon:false,date:"Sep 1, 2026"},...patch}}};
}
test("unnamed exact-App-ID recovery passes native sale eligibility without weakening named identity",()=>{
  const e=steamSaleEvidence(native("123","Recovered"),"123","",now);
  assert.equal(e.eligible,true);assert.equal(e.verifiedAppId,"123");
  assert.equal(steamSaleEvidence(native("123","Recovered"),"123","Wrong title",now).eligible,false);
  assert.throws(()=>steamSaleEvidence(native("123","Recovered",{steam_appid:456}),"123","",now),/identity/);
  for(const patch of [
    {name:""},{type:"dlc"},{type:"demo"},{type:"advertising"},{is_free:true},{is_free:undefined},
    {price_overview:{initial:0,currency:"USD"}},{price_overview:{initial:100,currency:"EUR"}},
    {price_overview:{initial:100.5,currency:"USD"}},{price_overview:null},
    {release_date:{coming_soon:true,date:"Sep 1, 2026"}},
    {release_date:{coming_soon:false,date:"Jan 1, 2027"}},
    {name:"Recovered Deluxe Edition"},
  ]){
    try{assert.equal(steamSaleEvidence(native("123","Recovered",patch),"123","",now).eligible,false,JSON.stringify(patch));}
    catch(err){if(patch.name==="")assert.match(String(err),/identity/);else throw err;}
  }
});
test("real NOT NULL production schema: identity recovery, duplicate guards, no history copies, repeat and rollback",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"steam-recovery-"));
  process.chdir(dir);let db:any;
  try{
    db=(await import("./storage")).rawSqlite;
    const seed=(id:number,sku:string,name:string|null=null,manual=0,paid=false,metadata=true)=>{
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,
        business_model_source,is_manual_override,refreshed_at,created_at)
        VALUES(?,'steam',?,'base',?,'fixture',?,'old','old')`).run(id,sku,paid?"paid":"unknown",manual);
      if(metadata)db.prepare("INSERT INTO console_title_igdb(title_id,name,store_name,summary,refreshed_at,created_at) VALUES(?,?,?,'preserve this','old','old')").run(id,name,name);
    };
    const reset=()=>{db.exec("DELETE FROM platform_sku_map;DELETE FROM console_title_igdb");};
    const all=(table:string)=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const protectedTables=["steam_review_history","store_rating_signal_daily","window_estimates_daily","title_ltd_state",
      "revenue_calibration_anchors","title_multiplier_overrides"];
    const protect=Object.fromEntries(protectedTables.map(t=>[t,all(t)]));
    const verify=async(p:any,sku:string,name:string)=>steamSaleEvidence(native(sku,"Recovered "+sku),sku,name,now);
    // Includes an existing blank metadata row and one with no metadata row.
    seed(90001,"123");seed(90002,"456",null,0,false,false);
    const before=all("platform_sku_map"),metadataBefore=all("console_title_igdb");
    const plan=await planSalesCoverage(loadSalesCatalog(db),verify);
    assert.ok(plan.every(d=>d.status==="promote"));
    const applied=applySalesCoverage(db,plan,now);
    assert.equal(applied.length,2);
    assert.ok(applied.every(d=>d.metadataRecovery));
    assert.deepEqual(all("platform_sku_map").map((r:any)=>r.title_id),[90001,90002]);
    assert.deepEqual(all("console_title_igdb").map((r:any)=>r.store_name),["Recovered 123","Recovered 456"]);
    assert.equal(all("console_title_igdb")[0].summary,"preserve this");
    assert.equal((await planSalesCoverage(loadSalesCatalog(db),verify)).length,0);
    assert.throws(()=>applySalesCoverage(db,plan,now),/Catalog changed/);
    for(const t of protectedTables)assert.deepEqual(all(t),protect[t],t);
    // Refuse to erase a later metadata writer; rollback is atomic.
    db.prepare("UPDATE console_title_igdb SET summary='later writer' WHERE title_id=90002").run();
    const held=all("platform_sku_map");
    assert.throws(()=>rollbackSalesCoverage(db,applied),/Rollback conflict/);
    assert.deepEqual(all("platform_sku_map"),held);
    db.prepare("UPDATE console_title_igdb SET summary=NULL WHERE title_id=90002").run();
    assert.equal(rollbackSalesCoverage(db,applied),2);
    assert.deepEqual(all("platform_sku_map"),before);
    assert.deepEqual(all("console_title_igdb"),metadataBefore);
    // Existing paid family blocks a newly learned alias; other unknown sibling
    // candidates are deduplicated within the same projected transaction.
    reset();seed(90001,"123");seed(90002,"456");seed(90003,"789","Already covered",0,true);
    const duplicate=await planSalesCoverage(loadSalesCatalog(db),async(p,sku,name)=>
      steamSaleEvidence(native(sku,"Already covered"),sku,name,now));
    assert.ok(duplicate.every(d=>d.status==="covered"));assert.equal(applySalesCoverage(db,duplicate,now).length,0);
    reset();seed(90001,"123");seed(90002,"456");
    const same=await planSalesCoverage(loadSalesCatalog(db),async(p,sku,name)=>
      steamSaleEvidence(native(sku,"One family"),sku,name,now));
    assert.deepEqual(same.map(d=>d.status),["promote","covered"]);
    assert.equal(applySalesCoverage(db,same,now).length,1);
    assert.equal(all("platform_sku_map").filter((r:any)=>r.business_model==="paid").length,1);
    // Recheck the recovered name under transaction lock, not only before HTTP.
    reset();seed(90001,"123");
    const racing=await planSalesCoverage(loadSalesCatalog(db),verify);
    seed(90002,"456","Recovered 123",0,true);
    assert.throws(()=>applySalesCoverage(db,racing,now),/Concurrent family/);
    assert.equal(all("platform_sku_map")[0].business_model,"unknown");
    // Native App ID attestation is required at both plan and apply boundaries.
    reset();seed(90001,"123");
    const spoof=await planSalesCoverage(loadSalesCatalog(db),async(p,sku,name)=>({...await verify(p,sku,name),verifiedAppId:"456"}));
    assert.equal(spoof[0].status,"hold");
    const tampered=await planSalesCoverage(loadSalesCatalog(db),verify);
    tampered[0].evidence!.verifiedAppId="456";
    assert.throws(()=>applySalesCoverage(db,tampered,now),/Invalid\/stale/);
    // Manual holds and non-Steam/invalid-ID unnamed rows never receive this path.
    reset();seed(90001,"123",null,1);seed(90002,"invalid");
    let calls=0;
    const holds=await planSalesCoverage(loadSalesCatalog(db),async()=>{calls++;throw Error("must not fetch");});
    assert.equal(calls,0);assert.ok(holds.every(d=>d.status==="hold"));
  }finally{db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});}
});
