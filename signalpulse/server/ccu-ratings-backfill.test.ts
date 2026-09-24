import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { makeCcuRatingsSql } from "../scripts/ccu-ratings-backfill";
import { CCU_RATINGS_SOURCE, isVerifiedRatingsOnly } from "./ratings-only-sku";

test("verified F2P console links reuse current ratings without changing paid/F2P sales gates", async () => {
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"ccu-ratings-"));
  process.chdir(dir); const real=globalThis.fetch;
  let db:any,server:any,service:any;
  try {
    const {rawSqlite}=await import("./storage");db=rawSqlite;
    const {registerReviewsRatingsRoutes}=await import("./routes-reviews-ratings");
    const app=express();service=registerReviewsRatingsRoutes(app);
    const now=new Date().toISOString(),day=now.slice(0,10);
    const evidence=[{appid:"578080",steam:{appId:"578080",name:"PUBG: BATTLEGROUNDS"},accepted:[{
      platform:"ps5",sku:"UP5082-PPSA27363_00-PUBGPS5000000000",name:"PUBG: BATTLEGROUNDS",
      url:"https://store.playstation.com/en-us/product/UP5082-PPSA27363_00-PUBGPS5000000000",
      data:{input:{productId:"UP5082-PPSA27363_00-PUBGPS5000000000"},productName:"PUBG: BATTLEGROUNDS",
        storeDisplayClassification:"FULL_GAME",pdpReleaseDate:"2025-11-13",conceptId:"232860",
        snapshot:{platform:"ps5",captureDate:day,sourceEndpoint:"ps:fixture",ratingCount:999,avgRating:4.3,windowLabel:"ltd"}}},{
      platform:"xbox",sku:"C0MN5DN8KR3F",name:"PUBG: BATTLEGROUNDS",
      url:"https://www.xbox.com/en-US/games/store/pubg-battlegrounds/C0MN5DN8KR3F",
      consoleCompatibility:["ConsoleGen8"],
      data:{input:{bigId:"C0MN5DN8KR3F"},productTitle:"PUBG: BATTLEGROUNDS",
        storeReleaseDateIso:"2018-09-04",snapshots:[{platform:"xbox",captureDate:day,
          sourceEndpoint:"xbox:fixture",ratingCount:222,avgRating:4.1,windowLabel:"ltd"}]}}]}];
    db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,is_manual_override,refreshed_at,created_at)
      VALUES(1,'steam','578080','base','free_to_play',1,?,?)`).run(now,now);
    db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
      VALUES(1,'PUBG: BATTLEGROUNDS','PUBG: BATTLEGROUNDS','2017-12-21',?,?)`).run(now,now);
    const before=db.prepare("SELECT * FROM platform_sku_map WHERE title_id=1").get();
    const sql=makeCcuRatingsSql(evidence,now);
    for(let pass=0;pass<2;pass++) for(const s of Object.values(sql))db.exec(s);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM verified_rating_links").get().n,2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM store_rating_signal_daily").get().n,2);
    assert.deepEqual(db.prepare("SELECT * FROM platform_sku_map WHERE title_id=1").get(),before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM platform_sku_map WHERE sku_role='base' AND business_model='paid'").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM window_estimates_daily").get().n,0);
    assert.equal(isVerifiedRatingsOnly({sku_role:"ratings_only",is_manual_override:1,business_model_source:CCU_RATINGS_SOURCE}),true);
    const p=evidence[0].accepted[0];
    globalThis.fetch=(async(input:any,init:any)=>{
      if(String(input).startsWith("http://127.0.0.1:"))return real(input,init);
      if(String(input).includes("appreviews"))return new Response(JSON.stringify({success:1,query_summary:{total_positive:80,total_negative:20,total_reviews:100}}));
      if(String(input).includes("web.np.playstation.com"))return new Response(JSON.stringify({data:{productRetrieve:{
        id:p.sku,name:p.name,storeDisplayClassification:"FULL_GAME",concept:{id:"232860"},
        starRating:{totalRatingsCount:1000,averageRating:4.4}}}}));
      if(String(input).includes("store.playstation.com"))return new Response("<html></html>");
      if(String(input).includes("displaycatalog"))return new Response(JSON.stringify({Product:{
        ProductId:"C0MN5DN8KR3F",LocalizedProperties:[{ProductTitle:"PUBG: BATTLEGROUNDS"}],
        MarketProperties:[{UsageData:[{AggregateTimeSpan:"AllTime",RatingCount:223,AverageRating:4.2}]}]}}));
      throw Error(`Unexpected QA request ${input}`);
    }) as typeof fetch;
    const {runPsCollector,runXboxCollector}=await import("./signals/console/runner");
    const collection=await runPsCollector([{titleId:0,productId:p.sku}],()=>{});
    assert.equal(collection.ingested,1);
    assert.equal((await runXboxCollector([{titleId:0,bigId:"C0MN5DN8KR3F"}],()=>{})).ingested,1);
    server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const url=`http://127.0.0.1:${server.address().port}/api/reviews-ratings/steam/578080`;
    await real(url);await service.settle();
    const result=await(await real(url)).json();
    assert.deepEqual(result.players.map((p:any)=>p.source),["steam","ps5","xbox"]);
    assert.equal(result.players[1].value,4.4);
    assert.equal(result.players[1].count,1000);
    assert.equal(result.players[2].count,223);
    assert.equal(result.players[2].value,4.2);
    for(const mutate of [
      (e:any)=>e[0].accepted[0].data.productName="PUBG 2",
      (e:any)=>e[0].accepted[0].data.snapshot.captureDate="2020-01-01",
      (e:any)=>e[0].accepted[0].url="https://example.com/unverified",
    ]) {const bad=structuredClone(evidence);mutate(bad);assert.throws(()=>makeCcuRatingsSql(bad));}
  } finally {
    await service?.settle();globalThis.fetch=real;
    if(server)await new Promise<void>(r=>server.close(r));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
