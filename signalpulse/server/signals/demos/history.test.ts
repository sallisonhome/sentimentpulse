import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeDemoHistory,recordDownloadObservation,recordReviewObservation} from "./history-schema";
import {loadDemoHistory} from "./history";
import {demoHistoryCsv} from "../../../shared/demo-detail";

function fixture(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE demo_download_actuals(steam_app_id,window,downloads,report_start_date,report_end_date,fetched_at,source);
    CREATE TABLE demo_window_estimates_daily(demo_title_id,window,as_of_date,units_mid,method,multiplier_id,review_count_total);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,created_at);
    CREATE TABLE demo_ccu_snapshots(id,demo_title_id,captured_at,ccu);
    CREATE TABLE demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu);`);
  initializeDemoHistory(db);return db;
}
const saber={id:1,steam_app_id:"5184670",is_saber_published:1,is_active:1};
const report=(date:string,downloads:number,end=date)=>({window:"ltd",downloads,reportStartDate:"2000-01-01",reportEndDate:end,fetchedAt:`${date}T07:00:00Z`});

test("migration is repeatable; seeds only original last-good capture date and excludes license metrics",()=>{
  const db=fixture();
  db.prepare("INSERT INTO demo_download_actuals VALUES(?,?,?,?,?,?,?)").run("5184670","ltd",12,"2000-01-01","2026-09-22","2026-09-22T07:00:00Z","steamworks_downloads_report");
  db.prepare("INSERT INTO demo_download_actuals VALUES(?,?,?,?,?,?,?)").run("999","ltd",500,"2000-01-01","2026-09-22","2026-09-22T07:00:00Z","complimentary_units");
  initializeDemoHistory(db);initializeDemoHistory(db);
  const rows=db.prepare("SELECT * FROM demo_download_observations").all() as any[];
  assert.equal(rows.length,1);assert.equal(rows[0].observation_date,"2026-09-22");
  recordDownloadObservation(db,"5184670",{...report("2026-09-22",15),fetchedAt:"2026-09-22T08:00:00Z"});
  initializeDemoHistory(db);
  assert.equal((db.prepare("SELECT downloads FROM demo_download_observations").get() as any).downloads,15);
  db.close();
});
test("actual changes require consecutive comparable reports; corrections retained, gaps/repeated dates null, archive LTD-only",()=>{
  const db=fixture();
  for(const r of [report("2026-09-21",100),report("2026-09-22",130),report("2026-09-23",125),
    report("2026-09-25",200),report("2026-09-26",210,"2026-09-25")])recordDownloadObservation(db,saber.steam_app_id,r);
  const result=loadDemoHistory(db,saber,"7","2026-09-26");
  assert.deepEqual(result.rows.map(r=>r.dailyDownloads),[null,null,30,-5,null,null,null]);
  assert.equal(result.rows[0].lifetimeDownloads,null);
  assert.equal(loadDemoHistory(db,{...saber,is_active:0},"all","2026-09-26").rows.some(r=>r.dailyDownloads!==null),false);
  recordDownloadObservation(db,saber.steam_app_id,report("2026-09-26",0));
  assert.equal(loadDemoHistory(db,saber,"7","2026-09-26").rows.at(-1)?.dailyDownloads,-200);
  db.close();
});
test("demo history never includes parents, overlapping weekly buckets, legacy license actuals, or invented cumulative reviews",()=>{
  const db=fixture(),title={...saber,is_saber_published:0};
  const day=Date.parse("2026-09-25T00:00:00Z")/1000;
  const bucket=db.prepare("INSERT INTO steam_review_history VALUES(?,?,?,?,?,?)");
  bucket.run(title.steam_app_id,day,"day",2,1,"2026-09-26T07:00:00Z");
  bucket.run(title.steam_app_id,day,"week",100,50,"2026-09-26T07:00:00Z");
  bucket.run("1551980",day,"day",9999,1,"2026-09-26T07:00:00Z");
  db.prepare("INSERT INTO demo_window_estimates_daily VALUES(?,?,?,?,?,?,?)").run(1,"ltd","2026-09-24",65.5,"review_delta_multiplier","historical_65_5",1);
  db.prepare("INSERT INTO demo_window_estimates_daily VALUES(?,?,?,?,?,?,?)").run(1,"ltd","2026-09-25",999,"steamworks_actual","legacy_licenses",999);
  db.prepare("INSERT INTO demo_ccu_snapshots VALUES(?,?,?,?)").run(1,1,"2026-09-25T07:00:00Z",10);
  db.prepare("INSERT INTO demo_ccu_snapshots VALUES(?,?,?,?)").run(2,1,"2026-09-25T08:00:00Z",0);
  recordReviewObservation(db,title.steam_app_id,0,10,"2026-09-26T07:00:00Z");
  recordReviewObservation(db,title.steam_app_id,10,0,"2026-09-26T06:00:00Z"); // older retry cannot regress
  const rows=loadDemoHistory(db,title,"7","2026-09-26").rows;
  assert.equal(rows[4].lifetimeDownloads,65.5);assert.equal(rows[4].multiplierId,"historical_65_5");
  assert.equal(rows[4].totalReviews,1);assert.equal(rows[4].positivePercent,null);
  assert.equal(rows[4].reviewSource,"retained_estimator_review_input");
  assert.equal(rows[5].dailyDownloads,390);assert.equal(rows[5].reviewsAdded,3);
  assert.equal(rows[5].lifetimeDownloads,null);assert.equal(rows[5].totalReviews,null);
  assert.equal(rows[5].ccuLatest,0);assert.equal(rows[5].ccuPeak,10);assert.equal(rows[5].ccuSamples,2);
  assert.equal(rows[6].positivePercent,0);assert.equal(rows[6].totalReviews,10);
  assert.equal(rows[6].dailyDownloads,null);
  const csv=demoHistoryCsv({appId:title.steam_app_id,isSaber:false,multiplier:130,rows} as any);
  assert.match(csv,/daily review bucket x 130/);assert.match(csv,/historical_65_5/);
  assert.equal(csv.split("\r\n").length,8);
  db.close();
});
test("empty histories remain null, date windows inclusive and bounded; daily zero stays zero",()=>{
  const db=fixture(),title={...saber,is_saber_published:0};
  const empty=loadDemoHistory(db,title,"30","2026-09-26");
  assert.equal(empty.rows.length,30);assert.equal(empty.firstHistoryDate,null);assert.equal(empty.start,"2026-08-28");
  db.prepare("INSERT INTO steam_review_history VALUES(?,?,?,?,?,?)")
    .run(title.steam_app_id,Date.parse("2026-09-26T00:00:00Z")/1000,"day",0,0,"2026-09-26T07:00:00Z");
  assert.equal(loadDemoHistory(db,title,"all","2026-09-26").rows[0].dailyDownloads,0);
  db.close();
});

test("real routes, authentication, collector snapshot writes, archived gates and exact parent-media isolation",async()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),"demo-detail-")),realFetch=globalThis.fetch;
  process.chdir(dir);
  let db:any,server:any;
  const env={mode:process.env.AUTH_MODE,secret:process.env.SABER_AUTH_JWT_SECRET};
  try{
    const module=await import("../../storage");db=module.rawSqlite;
    const {seedSaberDemos}=await import("./saber-seed");seedSaberDemos();
    const stamp=new Date().toISOString();
    db.prepare(`INSERT INTO demo_titles(steam_app_id,name,is_active,sku_kind,discovered_via,first_seen_at,created_at,updated_at)
      VALUES('99999','Friend Pass',1,'friends_pass','test',?,?,?)`).run(stamp,stamp,stamp);
    db.prepare(`INSERT INTO demo_titles(steam_app_id,name,is_active,is_saber_published,discovered_via,first_seen_at,created_at,updated_at)
      VALUES('99998','Unapproved retired demo',0,1,'test',?,?,?)`).run(stamp,stamp,stamp);
    const {registerDemoDetailRoutes}=await import("../../routes-demo-detail");
    const express=(await import("express")).default,app=express();
    registerDemoDetailRoutes(app);
    server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await realFetch(`${base}/api/demos/titles/99999`)).status,404);
    assert.equal((await realFetch(`${base}/api/demos/titles/99998`)).status,404);
    assert.equal((await realFetch(`${base}/api/demos/titles/nope`)).status,404);
    assert.equal((await realFetch(`${base}/api/demos/titles/5184670?days=999999`)).status,400);
    const archive=await(await realFetch(`${base}/api/demos/titles/4354730`)).json();
    assert.equal(archive.archived,true);assert.equal(archive.latest.reviews,null);

    // Successful collection persists a lifetime observation, not a made-up
    // historical observation per review bucket.
    globalThis.fetch=async()=>Response.json({success:1,results:{rollup_type:"month",
      recent:[{date:Date.parse(stamp.slice(0,10))/1000,recommendations_up:1,recommendations_down:0}],
      rollups:[{date:Date.parse(stamp.slice(0,10))/1000,recommendations_up:8,recommendations_down:2}]}});
    const {runDemosReviewHistoryCollector}=await import("./runner");
    await runDemosReviewHistoryCollector(0,new Set(["5184670"]));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_review_observations").get().n,1);
    assert.equal(db.prepare("SELECT positive+negative n FROM demo_review_observations").get().n,10);
    const body=await(await realFetch(`${base}/api/demos/titles/5184670`)).json();
    assert.equal(body.latest.reviews,10);assert.equal(body.latest.downloads,null);
    assert.equal(body.rows.at(-1).totalReviews,10);

    module.storage.upsertSetting("twitch_client_id","fixture-id");module.storage.upsertSetting("twitch_client_secret","fixture-secret");
    const calls:string[]=[];
    globalThis.fetch=async(input,init)=>{
      const url=String(input);calls.push(url);
      if(url.includes("oauth2/token"))return Response.json({access_token:"fixture-token",expires_in:3600});
      assert.equal(url,"https://api.igdb.com/v4/games");
      const query=String(init?.body);
      if(query.includes('uid="5184670"'))return Response.json([]);
      assert.match(query,/uid="1551980"/);
      return Response.json([{id:99,name:"Parent game",summary:"Verified parent media",cover:{image_id:"co123"},
        external_games:[{uid:"1551980",external_game_source:1}],genres:[{name:"Adventure"}],
        screenshots:[{image_id:"sc123"}],videos:[{video_id:"abcDEF12345"}],
        involved_companies:[{developer:true,company:{name:"Studio"}}]}]);
    };
    const art=await(await realFetch(`${base}/api/demos/titles/5184670/media`)).json();
    assert.equal(art.media.scope,"parent");assert.equal(art.media.matchedAppId,"1551980");
    assert.deepEqual(art.media.developers,["Studio"]);
    const count=calls.length;
    await realFetch(`${base}/api/demos/titles/5184670/media`);assert.equal(calls.length,count);
    assert.equal((await(await realFetch(`${base}/api/demos/titles/5184670`)).json()).latest.reviews,10);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM steam_review_history WHERE app_id='1551980'").get().n,0);
    db.prepare("UPDATE demo_media_cache SET last_attempt_at='2000-01-01' WHERE steam_app_id='5184670'").run();
    globalThis.fetch=async()=>{throw Error("fixture upstream secret must never be returned");};
    const stale=await(await realFetch(`${base}/api/demos/titles/5184670/media`)).json();
    assert.equal(stale.status,"unavailable");assert.equal(stale.stale,true);
    assert.equal(stale.media.igdbId,99);assert.ok(!JSON.stringify(stale).includes("fixture upstream"));
    globalThis.fetch=async()=>Response.json([]);
    const noMatch=await(await realFetch(`${base}/api/demos/titles/4010800/media`)).json();
    assert.equal(noMatch.status,"no_match");assert.equal(noMatch.media,null);
    const {verifiedDemoParent}=await import("./media");
    globalThis.fetch=async input=>{
      const id=JSON.parse(new URL(String(input)).searchParams.get("input_json")!).ids[0].appid;
      return Response.json({response:{store_items:[id===50000
        ? {id:50000,success:1,type:1,related_items:{parent_appid:50001}}
        : {id:50001,success:1,type:6}]}});
    };
    assert.equal(await verifiedDemoParent("50000"),null,"software parent cannot supply game media");

    await new Promise<void>(r=>server.close(r));server=null;
    process.env.AUTH_MODE="saber";process.env.SABER_AUTH_JWT_SECRET="fixture-secret";
    const secured=express();secured.use((await import("../../saber-auth")).createSaberAuthMiddleware().middleware);
    registerDemoDetailRoutes(secured);server=secured.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    for(const suffix of ["","/media"])assert.equal((await realFetch(`http://127.0.0.1:${server.address().port}/api/demos/titles/5184670${suffix}`)).status,401);
  }finally{
    globalThis.fetch=realFetch;
    if(server)await new Promise<void>(r=>server.close(r));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
    for(const [key,value] of Object.entries({AUTH_MODE:env.mode,SABER_AUTH_JWT_SECRET:env.secret}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
