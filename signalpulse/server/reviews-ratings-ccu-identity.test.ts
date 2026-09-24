import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { reviewedCriticAlias, reviewedConsoleVersion } from "./reviews-ratings-aliases";
import { criticSearchTitle } from "./reviews-ratings-normalize";

test("reviewed aliases are exact, preserve sequels and label distinct console editions", () => {
  assert.equal(reviewedCriticAlias("3321460", "Crimson Desert Enhanced")?.id, 19373);
  assert.equal(reviewedCriticAlias("3240220", "Grand Theft Auto V Enhanced")?.id, 163);
  assert.equal(reviewedCriticAlias("271590", "Grand Theft Auto V Legacy")?.id, 163);
  assert.equal(reviewedCriticAlias("3240220", "Grand Theft Auto VI"), null);
  assert.equal(reviewedCriticAlias("3240220", "Grand Theft Auto Online"), null);
  assert.equal(reviewedCriticAlias("999", "Crimson Desert Enhanced"), null);
  assert.equal(reviewedCriticAlias("2357570", "Overwatch®")?.id, 13288);
  assert.notEqual(reviewedCriticAlias("2357570", "Overwatch®")?.id, 1673);
  assert.equal(reviewedCriticAlias("39210", "FINAL FANTASY XIV Online")?.id, 271);
  assert.equal(criticSearchTitle("Helldivers 2"), "Helldivers II");
  assert.equal(criticSearchTitle("Helldivers 3"), "Helldivers 3");
  assert.equal(reviewedConsoleVersion("252490", "Rust", "Rust Console Edition X|S"), true);
  assert.equal(reviewedConsoleVersion("252490", "Rust 2", "Rust Console Edition"), false);
  assert.equal(reviewedConsoleVersion("552990", "World of Warships", "World of Warships: Legends"), false);
  assert.equal(reviewedConsoleVersion("440", "Team Fortress 2", "The Orange Box"), false);
});

test("CCU routes keep exact Steam ratings, reuse verified consoles and pass linked release evidence to critics", async () => {
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"ccu-identity-"));process.chdir(dir);
  const real=globalThis.fetch;let db:any,service:any,server:any;
  const metadata:Record<string,any>={
    "1172470":{name:"Apex Legends™",date:"Nov 4, 2020"},
    "271590":{name:"Grand Theft Auto V Legacy",date:"Apr 14, 2015"},
  };
  const detail:Record<number,any>={
    7267:{id:7267,name:"Apex Legends",release_date:"2019-02-04",platforms:[]},
    163:{id:163,name:"Grand Theft Auto V",release_date:"2014-11-18",platforms:[]},
    19373:{id:19373,name:"Crimson Desert",release_date:"2026-03-19",platforms:[]},
  };
  try{
    const mod=await import("./storage");db=mod.rawSqlite;
    globalThis.fetch=(async(input:any,init:any)=>{
      const url=String(input);if(url.startsWith("http://127.0.0.1:"))return real(input,init);
      if(url.includes("/appreviews/"))return new Response(JSON.stringify({success:1,query_summary:{total_positive:80,total_negative:20,total_reviews:100}}));
      if(url.includes("api/appdetails")){
        const id=new URL(url).searchParams.get("appids")!,m=metadata[id];assert.ok(m,url);
        return new Response(JSON.stringify({[id]:{success:true,data:{steam_appid:Number(id),name:m.name,type:"game",release_date:{date:m.date}}}}));
      }
      if(url.includes("/games/search")){
        assert.equal(new URL(url).searchParams.get("query"),"Apex Legends");
        return new Response(JSON.stringify({results:[{id:7267,name:"Apex Legends",type:"game"}]}));
      }
      if(url.includes("/games/details")){
        const d=detail[Number(new URL(url).searchParams.get("game"))];assert.ok(d,url);
        return new Response(JSON.stringify({...d,steam_id:null,review_count:80,top_critic_score:80,percent_recommended:80,tier:"Strong"}));
      }throw Error(`Unexpected request ${url}`);
    }) as typeof fetch;
    const {registerReviewsRatingsRoutes}=await import("./routes-reviews-ratings");
    const app=express();service=registerReviewsRatingsRoutes(app);
    mod.storage.upsertSetting("opencritic_rapidapi_key","test-only-not-real");
    const now=new Date().toISOString(),day=now.slice(0,10);
    for(const [id,platform,sku,name,date]of [
      [1,"steam","3240220","Grand Theft Auto V Enhanced","2025-03-04"],
      [2,"xbox","GTAVCONSOLE1","Grand Theft Auto V Enhanced","2022-03-15"],
      [3,"steam","3321460","Crimson Desert Enhanced","2026-03-19"],
      [4,"xbox","APEXCONSOLE1","Apex Legends™","2019-02-04"],
    ]){
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',?,?)`).run(id,platform,sku,now,now);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,?,?,?)`).run(id,name,name,date,now,now);
      if(platform==="xbox")db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,avg_rating,window_label,created_at)
        VALUES(?,'xbox',?,'test',100,4.2,'ltd',?)`).run(id,day,now);
    }
    db.prepare(`INSERT INTO verified_rating_links VALUES('xbox','APEXCONSOLE1','1172470','Apex Legends',
      'https://www.xbox.com/',?,'verified_ratings_only:ccu_2026-09-24')`).run(now);
    // A miss cached with Steam-only evidence must not block new console evidence.
    db.prepare(`INSERT INTO review_rating_cache VALUES(?,NULL,NULL,?,?, 'ambiguous')`)
      .run("opencritic:v2:apexlegends:2020-11-04",Date.now(),Date.now()+86400000);
    server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    for(const [id,critic,consoles]of [["1172470",7267,1],["271590",163,1],["3240220",163,1],["3321460",19373,0]] as const){
      const url=`http://127.0.0.1:${server.address().port}/api/reviews-ratings/steam/${id}`;
      for(let i=0;i<3;i++){await real(url);await service.settle();}
      const b=await(await real(url)).json();
      assert.equal(b.openCritic.status,"ready",JSON.stringify(b));
      assert.equal(b.openCritic.id,critic);
      assert.equal(b.players.filter((p:any)=>p.source!=="steam").length,consoles);
      assert.ok(b.players[0].url.includes(`/app/${id}/`));
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM window_estimates_daily").get().n,0);
  }finally{
    await service?.settle();globalThis.fetch=real;
    if(server)await new Promise<void>(r=>server.close(r));db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
