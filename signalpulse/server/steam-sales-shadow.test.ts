import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {collectSteamSalesCcu,initSteamSalesShadow,proposeSteamSalesAdjustment} from "./steam-sales-shadow";
test("CCU transport errors, duplicates and rate limits never manufacture observations",async()=>{
  const db=new Database(":memory:");initSteamSalesShadow(db);initSteamSalesShadow(db);
  const now=new Date("2026-09-28T09:15:00Z");
  let r=await collectSteamSalesCcu(db,(async()=>new Response("bad",{status:503})) as any,now);
  assert.equal(r.status,"unavailable");assert.equal(db.prepare("SELECT COUNT(*) n FROM steam_sales_ccu_samples").get().n,0);
  r=await collectSteamSalesCcu(db,(async()=>new Response(JSON.stringify({response:{ranks:[
    {appid:1,rank:1,concurrent_in_game:10},{appid:1,rank:2,concurrent_in_game:20}]}}))) as any,now);
  assert.equal(r.status,"unavailable");assert.equal(db.prepare("SELECT COUNT(*) n FROM steam_sales_ccu_samples").get().n,0);
  r=await collectSteamSalesCcu(db,(async()=>new Response("",{status:429,headers:{"retry-after":"172800"}})) as any,now);
  assert.equal(r.status,"cooldown");
  r=await collectSteamSalesCcu(db,(async()=>{throw Error("must not fetch before provider deadline");}) as any,new Date("2026-09-29T09:15:00Z"));
  assert.equal(r.status,"cooldown");db.close();
});
test("durable operator disable prevents network in separate daily process",async()=>{
  const db=new Database(":memory:");initSteamSalesShadow(db);
  db.exec("CREATE TABLE app_settings(key TEXT,value TEXT);INSERT INTO app_settings VALUES('steam_sales_shadow_enabled','0')");
  const r=await collectSteamSalesCcu(db,(async()=>{throw Error("disabled");}) as any);
  assert.equal(r.status,"disabled");db.close();
});
test("CCU alone, negative inputs and duplicate days cannot become a sales proposal",()=>{
  const days=Array.from({length:14},(_,i)=>({date:new Date(Date.UTC(2026,8,1+i)).toISOString().slice(0,10),ccu:1000,reviews:0,minuteUtc:555}));
  const input={days,endDate:"2026-09-14",baseline:40,shock:false,protectedTitle:false,anchorCoefficient:null};
  for(const sample of [days,days.map(d=>({...d,reviews:-1})),[days[0],...days.slice(0,-1)]]){
    const r=proposeSteamSalesAdjustment({...input,days:sample});
    assert.equal(r.proposedFactor,1);assert.equal(r.applied,false);
  }
});
