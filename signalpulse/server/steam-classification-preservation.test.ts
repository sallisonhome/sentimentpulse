import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("missing Steam classification preserves paid evidence but explicit DLC does not",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"steam-classification-"));
  process.chdir(dir);let db:any;
  try{
    db=(await import("./storage")).rawSqlite;
    const {upsertSkuMap}=await import("./signals/console/discovery");
    const base={platform:"steam" as const,externalSku:"qa-paid",titleId:99001,conceptId:null,
      skuRole:"base",businessModel:"paid" as const,msrpUsdCents:4999,businessModelSource:"verified_game"};
    const row=(sku=base.externalSku)=>db.prepare("SELECT * FROM platform_sku_map WHERE platform='steam' AND external_sku=?").get(sku);
    upsertSkuMap([base]);const before=row();
    const unavailable={...base,businessModel:"unknown" as const,msrpUsdCents:null,
      businessModelSource:"steam_appdetails.is_free=false;type=?",classificationUnavailable:true};
    const kept=upsertSkuMap([unavailable]);
    assert.equal(kept.preservedUnavailable,1);assert.deepEqual(row(),before);
    upsertSkuMap([{...unavailable,externalSku:"qa-new",titleId:99002}]);
    assert.equal(row("qa-new").business_model,"unknown");
    upsertSkuMap([{...base,msrpUsdCents:5999}]);assert.equal(row().msrp_usd_cents,5999);
    upsertSkuMap([{...base,titleId:123456,msrpUsdCents:6499}]);
    assert.equal(row().title_id,99001);assert.equal(row().msrp_usd_cents,6499);
    upsertSkuMap([{...unavailable,classificationUnavailable:false,businessModelSource:"steam_appdetails.is_free=false;type=dlc",skuRole:"dlc"}]);
    assert.equal(row().business_model,"unknown");assert.equal(row().sku_role,"dlc");
    upsertSkuMap([{...base,externalSku:"qa-manual",titleId:99003,isManualOverride:true}]);
    upsertSkuMap([{...unavailable,externalSku:"qa-manual",titleId:99003,classificationUnavailable:false}]);
    assert.equal(row("qa-manual").business_model,"paid");
    assert.throws(()=>upsertSkuMap([{...base,businessModel:"free_to_play"}]),/free_to_play/);
  }finally{db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});}
});

test("Steam appdetails rate limit opens the circuit instead of hammering remaining titles",async()=>{
  const {classifySteamAppIds}=await import("./signals/console/discovery");
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return new Response("null",{status:429,statusText:"Too Many Requests"});};
    const rows=await classifySteamAppIds(["123","456","789"]);
    assert.equal(calls,1);assert.equal(rows.length,3);
    assert.ok(rows.every(row=>row.businessModel==="unknown"&&row.type===null));
  }finally{globalThis.fetch=original;}
});

test("timer schedules its service without activating it on timer startup",()=>{
  const timer=readFileSync("deploy/signalpulse-daily.timer","utf8");
  assert.match(timer,/^Unit=signalpulse-daily.service$/m);
  assert.match(timer,/^OnCalendar=/m);
  assert.doesNotMatch(timer,/^Requires=.*signalpulse-daily.service/m);
});

test("real Steam classifier distinguishes unavailable metadata from verified DLC",async()=>{
  const {classifySteamAppIds}=await import("./signals/console/discovery");
  const original=globalThis.fetch;
  const responses=[
    {"123":{success:false}},
    {"123":{success:true,data:{type:"dlc",name:"Verified DLC",is_free:false}}},
    {"123":{success:true,data:{type:"game",name:"Verified Game",is_free:false,price_overview:{initial:4999}}}},
  ];
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify(responses.shift()),{status:200});
    const [missing]=await classifySteamAppIds(["123"]);
    assert.equal(missing.businessModel,"unknown");assert.equal(missing.type,null);
    const [dlc]=await classifySteamAppIds(["123"]);
    assert.equal(dlc.businessModel,"unknown");assert.equal(dlc.type,"dlc");
    const [game]=await classifySteamAppIds(["123"]);
    assert.equal(game.businessModel,"paid");assert.equal(game.msrpUsdCents,4999);
    assert.equal(responses.length,0);
  }finally{globalThis.fetch=original;}
});
