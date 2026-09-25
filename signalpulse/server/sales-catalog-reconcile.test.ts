import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySalesCoverage,rollbackSalesCoverage,coveredBy,loadSalesCatalog,planSalesCoverage,type CatalogRow } from "./sales-catalog-reconcile";
import { xboxSaleEvidence,psSaleEvidence,psUsdSibling,steamSaleEvidence,type SaleEvidence } from "./sales-catalog-eligibility";
import { CCU_RATINGS_SOURCE } from "./ratings-only-sku";
import { editionGroupKey } from "./console-sales-family";
import { fetchSteamCatalogJson } from "./sales-catalog-steam-http";
const now=new Date("2026-09-25T12:00:00Z");
test("Steam transport paces new calls, retries transient failures, honors cooldowns and remains bounded",async()=>{
  for(const statuses of [[200],[429,200],[503,429,200],[429,429,429],[404]]){
    const pauses:number[]=[],calls:string[]=[];
    const fake=(async(url:string)=>{
      calls.push(url);const status=statuses[calls.length-1];
      return new Response(status===200?'{"verified":true}':"unavailable",{status});
    }) as typeof fetch;
    const action=fetchSteamCatalogJson("https://store.steampowered.com/api/appdetails?appids=1",fake,async ms=>{pauses.push(ms);});
    if(statuses.at(-1)===200)assert.deepEqual(await action,{verified:true});
    else await assert.rejects(action,/steam storefront HTTP/);
    assert.equal(calls.length,statuses.length);assert.equal(pauses[0],750);
    assert.ok(pauses.every(ms=>ms>=750&&ms<=15000));
  }
  let count=0;
  await assert.rejects(fetchSteamCatalogJson("x",(async()=>{
    count++;return new Response("",{status:429,headers:{"Retry-After":"120"}});
  }) as typeof fetch,async()=>{}),/retry_after_deferred/);
  assert.equal(count,1);
  const delays:number[]=[];let attempts=0;
  await fetchSteamCatalogJson("x",(async()=>++attempts===1?
    new Response("",{status:429,headers:{"Retry-After":"2"}}):
    new Response("{}")) as typeof fetch,async ms=>{delays.push(ms);});
  assert.deepEqual(delays,[750,2000]);
});
function row(id=1,platform="xbox",name="Example"):CatalogRow{
  return {id,title_id:10000+id,platform:platform as any,external_sku:"SKU"+id,
    concept_id:null,sku_role:"ratings_only",business_model:"unknown",msrp_usd_cents:null,
    business_model_source:CCU_RATINGS_SOURCE,is_manual_override:1,name};
}
function evidence(r:CatalogRow):SaleEvidence{
  return {platform:r.platform,sku:r.external_sku,name:r.name!,checkedAt:now.toISOString(),
    sourceUrls:["https://example.test/verified"],released:"2026-09-01",msrpUsdCents:5999,
    eligible:true,reason:"verified_paid_base"};
}
function dbFor(rows:CatalogRow[]){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE platform_sku_map(id INTEGER PRIMARY KEY,title_id INTEGER,platform TEXT,external_sku TEXT,
    concept_id TEXT,sku_role TEXT,business_model TEXT,msrp_usd_cents INTEGER,business_model_source TEXT,
    is_manual_override INTEGER,refreshed_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(platform,external_sku));
    CREATE TABLE console_title_igdb(title_id INTEGER PRIMARY KEY,name TEXT,store_name TEXT,store_release_date TEXT,refreshed_at TEXT,created_at TEXT);
    CREATE TABLE xbox_title_cache(big_id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE protected_inputs(value TEXT); INSERT INTO protected_inputs VALUES('unchanged');
    CREATE TABLE verified_rating_links(platform TEXT,external_sku TEXT,steam_app_id TEXT,store_name TEXT,verification_source TEXT);`);
  for(const r of rows){
    db.prepare("INSERT INTO platform_sku_map VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(r.id,r.title_id,r.platform,r.external_sku,r.concept_id,r.sku_role,r.business_model,r.msrp_usd_cents,r.business_model_source,r.is_manual_override,"old","old");
    db.prepare("INSERT INTO console_title_igdb VALUES(?,?,?,?,?,?)").run(r.title_id,r.name,r.name,"2026-09-01","old","old");
    if(r.platform==="xbox")db.prepare("INSERT INTO xbox_title_cache VALUES(?,?)").run(r.external_sku,r.name);
  }
  return db;
}
test("all-catalog promotion outside rankings; repeated days are idempotent; inputs and IDs preserved",async()=>{
  const rows=[row(1),row(2,"ps5","Different")],db=dbFor(rows);
  try{
    const before=db.prepare("SELECT * FROM protected_inputs").all();
    const decisions=await planSalesCoverage(loadSalesCatalog(db),async(p,s,n)=>evidence({...rows.find(r=>r.external_sku===s)!,name:n}));
    assert.equal(decisions.filter(d=>d.status==="promote").length,2);
    const applied=applySalesCoverage(db,decisions,now);assert.equal(applied.length,2);
    const after=db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all();
    assert.deepEqual((after as any[]).map(r=>r.title_id),[10001,10002]);
    for(let day=0;day<3;day++){
      const again=await planSalesCoverage(loadSalesCatalog(db),async()=>{throw Error("Should not refetch paid bases");});
      assert.equal(applySalesCoverage(db,again,now).length,0);
      assert.deepEqual(db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all(),after);
    }
    assert.deepEqual(db.prepare("SELECT * FROM protected_inputs").all(),before);
  }finally{db.close();}
});
test("same family, concept, shared title ID and regional duplicates never add revenue observations",async()=>{
  const a={...row(1,"ps5"),concept_id:"123",sku_role:"base",business_model:"paid",msrp_usd_cents:5999};
  for(const b of [
    {...row(2,"ps5"),name:"Example PS4 & PS5"},
    {...row(2,"ps5","Different naming"),concept_id:"123"},
    {...row(2,"ps5","Different naming"),title_id:a.title_id},
  ]){
    assert.deepEqual(coveredBy(b,[a,b]),[a.title_id]);
    const d=await planSalesCoverage([a,b],async()=>{throw Error("Covered rows must not be promoted");});
    assert.equal(d[0].status,"covered");
  }
  const rows=[row(1,"ps5"),row(2,"ps5")];
  const ds=await planSalesCoverage(rows,async(p,s)=>evidence(rows.find(r=>r.external_sku===s)!));
  assert.deepEqual(ds.map(d=>d.status),["promote","covered"]);
});
test("multiple new Steam counterparts use distinct atomic IDs, no copied reviews, and guarded rollback",async()=>{
  const db=dbFor([row(1,"xbox"),row(2,"ps5","Another")]);
  db.prepare("INSERT INTO verified_rating_links VALUES('xbox','SKU1','12345','Example',?)").run(CCU_RATINGS_SOURCE);
  db.prepare("INSERT INTO verified_rating_links VALUES('ps5','SKU2','12346','Another',?)").run(CCU_RATINGS_SOURCE);
  try{
    const plan=await planSalesCoverage(loadSalesCatalog(db),async(p,s,n)=>evidence({...row(1,p,n),external_sku:s}));
    assert.equal(plan.filter(d=>d.status==="promote").length,4);
    const applied=applySalesCoverage(db,plan,now);
    const steam=db.prepare("SELECT * FROM platform_sku_map WHERE platform='steam' ORDER BY title_id").all() as any[];
    assert.deepEqual(steam.map(r=>r.title_id),[10003,10004]);
    assert.deepEqual(steam.map(r=>r.external_sku).sort(),["12345","12346"]);
    assert.equal(loadSalesCatalog(db).filter(r=>r.is_new).length,0);
    assert.equal((await planSalesCoverage(loadSalesCatalog(db))).length,0);
    assert.deepEqual(db.prepare("SELECT * FROM protected_inputs").all(),[{value:"unchanged"}]);
    db.prepare("UPDATE platform_sku_map SET msrp_usd_cents=999 WHERE id=1").run();
    assert.throws(()=>rollbackSalesCoverage(db,applied),/Rollback conflict/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM platform_sku_map WHERE business_model='paid'").get() as any).n,4);
    db.prepare("UPDATE platform_sku_map SET msrp_usd_cents=5999 WHERE id=1").run();
    assert.equal(rollbackSalesCoverage(db,applied),4);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM platform_sku_map WHERE business_model='paid'").get() as any).n,0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM platform_sku_map").get() as any).n,4);
  }finally{db.close();}
});
test("unknown Steam base recovers only with verification and respects manual holds",async()=>{
  const r={...row(1,"steam"),sku_role:"base",is_manual_override:0};
  const d=await planSalesCoverage([r],async()=>evidence(r));assert.equal(d[0].status,"promote");
  const manual={...r,is_manual_override:1};
  assert.equal((await planSalesCoverage([manual],async()=>evidence(manual)))[0].status,"hold");
});
test("source failures and exhausted budget defer new admissions without touching existing sales",async()=>{
  const rows=[row(1),{...row(2,"steam","Already paid"),sku_role:"base",business_model:"paid"}];
  const db=dbFor(rows);
  try{
    const before=db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all();
    const failed=await planSalesCoverage(loadSalesCatalog(db),async()=>{throw Error("HTTP 429");});
    assert.equal(failed[0].status,"error");
    assert.equal(applySalesCoverage(db,failed,now).length,0);
    const deferred=await planSalesCoverage(loadSalesCatalog(db),async()=>{throw Error("Must not fetch");},{deadlineMs:0});
    assert.equal(deferred[0].reason,"verification_budget_deferred");
    assert.deepEqual(db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all(),before);
    const visited:string[]=[];
    await planSalesCoverage([row(1),row(2,"xbox","Another")],async(p,s,n)=>{
      visited.push(s);return evidence({...row(1,p,n),external_sku:s});
    },{rotationOffset:1});
    assert.deepEqual(visited,["SKU2","SKU1"]);
  }finally{db.close();}
});
test("changed catalog, stale evidence and a racing duplicate abort the whole transaction",async()=>{
  for(const mutation of ["stale","changed","duplicate","concept","manual","evidenceIdentity"]){
    const rows=[row(1),row(2,"ps5","Different")],db=dbFor(rows);
    try{
      const plan=await planSalesCoverage(loadSalesCatalog(db),async(p,s)=>evidence(rows.find(r=>r.external_sku===s)!));
      if(mutation==="stale")plan[1].evidence!.checkedAt="2026-09-01T00:00:00Z";
      if(mutation==="changed")db.prepare("UPDATE platform_sku_map SET business_model='free_to_play' WHERE id=2").run();
      if(mutation==="concept")db.prepare("UPDATE platform_sku_map SET concept_id='changed' WHERE id=2").run();
      if(mutation==="manual")db.prepare("UPDATE platform_sku_map SET is_manual_override=0 WHERE id=2").run();
      if(mutation==="evidenceIdentity")plan[1].evidence!.name="Wrong title";
      if(mutation==="duplicate"){
        db.prepare("INSERT INTO platform_sku_map VALUES(3,10003,'ps5','SKU3',NULL,'base','paid',5999,'manual',1,'old','old')").run();
        db.prepare("INSERT INTO console_title_igdb VALUES(10003,'Different','Different','2026-01-01','old','old')").run();
      }
      const before=db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all();
      assert.throws(()=>applySalesCoverage(db,plan,now));
      assert.deepEqual(db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all(),before);
    }finally{db.close();}
  }
});
function xbox(overrides:any={}){
  return {Product:{ProductId:"SKU1",ProductType:"Game",LocalizedProperties:[{ProductTitle:"Example"}],
    Properties:{XboxConsoleGenCompatible:["ConsoleGen9"]},MarketProperties:[{OriginalReleaseDate:"2026-09-01"}],
    DisplaySkuAvailabilities:[{Sku:{SkuType:"full"},Availabilities:[{Actions:["Purchase"],
      OrderManagementData:{Price:{MSRP:59.99,CurrencyCode:"USD"}},Conditions:{StartDate:"2026-01-01",EndDate:"2027-01-01"}}]}],...overrides}};
}
test("Xbox rejects F2P, PC-only, demo, DLC, preorders, stale/nonpurchase offers and wrong IDs",()=>{
  assert.equal(xboxSaleEvidence(xbox(),"SKU1","Example",now).eligible,true);
  for(const patch of [
    {ProductId:"WRONG"},{ProductType:"GameDurable"},
    {Properties:{XboxConsoleGenCompatible:[]}},
    {Properties:{XboxConsoleGenCompatible:["ConsoleGen9"],IsDemo:true}},
    {MarketProperties:[{OriginalReleaseDate:"2027-01-01"}]},
    {LocalizedProperties:[{ProductTitle:"Example Deluxe Edition"}]},
    {DisplaySkuAvailabilities:[]},
    {DisplaySkuAvailabilities:[{Sku:{SkuType:"trial"},Availabilities:[{Actions:["Purchase"],OrderManagementData:{Price:{MSRP:59.99,CurrencyCode:"USD"}}}]}]},
  ])assert.equal(xboxSaleEvidence(xbox(patch),"SKU1","Example",now).eligible,false,JSON.stringify(patch));
  for(const price of [0,-1,NaN]){
    const p=xbox();p.Product.DisplaySkuAvailabilities[0].Availabilities[0].OrderManagementData.Price.MSRP=price;
    assert.equal(xboxSaleEvidence(p,"SKU1","Example",now).eligible,false);
  }
  const p=xbox();p.Product.DisplaySkuAvailabilities[0].Availabilities[0].Actions=["License"];
  assert.equal(xboxSaleEvidence(p,"SKU1","Example",now).eligible,false);
});
function psHtml(sku="SKU1",extra:any={},priceExtra:any={}){
  return `<script type="application/json">${JSON.stringify({cache:{
    [`Product:${sku}`]:{id:sku,name:"Example",concept:{__ref:"Concept:123"},platforms:["PS5"],
      releaseDate:"2026-09-01",storeDisplayClassification:"FULL_GAME",...extra},
    "GameCTA:one":{__typename:"GameCTA",type:"ADD_TO_CART",action:{type:"ADD_TO_CART",param:[{name:"skuId",value:sku+"-U001"}]},
      price:{basePriceValue:5999,currencyCode:"USD",isFree:false,isTiedToSubscription:false,...priceExtra}},
  }})}</script>`;
}
test("PS pricing binds exact product and USD outright offer, excluding PS4, DLC, upsells and subscriptions",()=>{
  const get=(html:string)=>psSaleEvidence(html,"SKU1","Example","https://store.playstation.com/en-us/product/SKU1",now);
  assert.equal(get(psHtml()).msrpUsdCents,5999);
  assert.equal(get(psHtml("OTHER")).eligible,false);
  assert.equal(get(psHtml("SKU1",{platforms:["PS4"]})).eligible,false);
  assert.equal(get(psHtml("SKU1",{storeDisplayClassification:"ADD_ON"})).eligible,false);
  for(const p of [{currencyCode:"GBP"},{isFree:true},{isTiedToSubscription:true},{isExclusive:true},{basePriceValue:0}])
    assert.equal(get(psHtml("SKU1",{},p)).eligible,false);
  // Unrelated recommendations and a deluxe price never provide the base MSRP.
  assert.equal(get(psHtml("SKU1",{}, {currencyCode:"GBP"})+psHtml("OTHER")).eligible,false);
  const primary=get(psHtml("SKU1",{}, {currencyCode:"GBP"}));
  assert.equal(psUsdSibling(primary,psHtml("USSKU"),"https://store.playstation.com/en-us/concept/123",now).eligible,true);
  assert.equal(psUsdSibling(primary,psHtml("USSKU",{concept:{__ref:"Concept:999"}}),"x",now).eligible,false);
  assert.equal(psUsdSibling(primary,psHtml("USSKU",{name:"Example Deluxe Edition"}),"x",now).eligible,false);
});
test("Steam requires exact embedded ID, paid game, valid release, and USD price",()=>{
  const body:any={12345:{success:true,data:{steam_appid:12345,name:"Example",type:"game",is_free:false,
    release_date:{date:"Sep 1, 2026",coming_soon:false},price_overview:{currency:"USD",initial:5999}}}};
  assert.equal(steamSaleEvidence(body,"12345","Example",now).eligible,true);
  body[12345].data.type="dlc";assert.equal(steamSaleEvidence(body,"12345","Example",now).eligible,false);
  body[12345].data.type="game";body[12345].data.is_free=true;
  assert.equal(steamSaleEvidence(body,"12345","Example",now).eligible,false);
  body[12345].data.steam_appid=99;assert.throws(()=>steamSaleEvidence(body,"12345","Example",now));
});
test("family normalization joins reviewed versions, never unrelated sequels, remakes or Townfall Xbox",()=>{
  for(const [a,b] of [["NBA 2K26 for PS5","NBA 2K26"],["RimWorld Console Edition","RimWorld"],
    ["Don't Starve Together: Console Edition","Don't Starve Together"],
    ["Subnautica 2 (Game Preview)","Subnautica 2"],
    ["The Elder Scrolls V: Skyrim Special Edition - PS5 & PS4","The Elder Scrolls V: Skyrim Special Edition"]])
    assert.equal(editionGroupKey(a),editionGroupKey(b));
  for(const [a,b] of [["Control","Control Resonant"],["Subnautica","Subnautica 2"],["RimWorld","RimWorld 2"],["Silent Hill 2","Silent Hill: Townfall"],["Example","Example Remake"]])
    assert.notEqual(editionGroupKey(a),editionGroupKey(b));
  const townfall=row(1,"ps5","Silent Hill: Townfall");
  assert.equal(coveredBy(townfall,[townfall]).length,0);
});
