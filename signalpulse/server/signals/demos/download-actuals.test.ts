import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allHistoryReportUrl, parseDownloadReport, downloadWindowStart, DEMO_ACTUAL_WINDOWS, DOWNLOAD_DEFINITION } from "./download-report";

const end = "2026-09-22";
const name = "Docked Demo";
// Minimal structural fixtures from the verified 2026-09-22 upstream contract.
function html(title = name, total = "128,512", start = "2000-01-01", id = "4010800") {
  return `<h1>Game: ${title} - Downloads by Region</h1>
    <a href="https://partner.steampowered.com/nav_regions.php?downloads=1&amp;appID=${id}&amp;dateStart=2000-01-01&amp;dateEnd=${end}">all history</a>
    ${start === "2000-01-01" ? "( lifetime sales shown )" : ""}
    <INPUT TYPE="text" NAME="dateStart" VALUE="${start}" />
    <INPUT TYPE="text" NAME="dateEnd" VALUE="${end}" />
    <p>*${DOWNLOAD_DEFINITION}</p><div>Total Downloads:    ${total}</div>`;
}
test("actual parser verifies demo identity, metric, lifetime scope and exact date inputs", () => {
  assert.equal(parseDownloadReport(html(), name, "2000-01-01", end), 128512);
  assert.equal(parseDownloadReport(html(name,"0","2026-09-16"),name,"2026-09-16",end),0);
  for (const bad of [html("Docked"), html().replace(DOWNLOAD_DEFINITION,"Free licenses"),
    html().replace("lifetime sales shown","today"), html().replace('VALUE="2000-01-01"','VALUE="2026-09-22"'),
    html().replace("128,512","128,51"), html().replace("128,512","-1"),
    html()+"<div>Total Downloads: 42</div>", "<h1>Sign in</h1>"]) {
    assert.throws(()=>parseDownloadReport(bad,name,"2000-01-01",end));
  }
  assert.throws(()=>parseDownloadReport(html(),name,"2026-09-16",end), "Lifetime total cannot masquerade as 7-day actuals");
});
test("all-history URL cannot escape approved host, demo App ID or download-report scope", () => {
  const url = allHistoryReportUrl(html(),"4010800",name);
  assert.equal(new URL(url).searchParams.get("appID"),"4010800");
  for (const bad of [html().replace("partner.steampowered.com","evil.example"),
    html().replace("appID=4010800","appID=2487300"), html().replace("downloads=1","downloads=0"),
    html().replace("all history","today")]) assert.throws(()=>allHistoryReportUrl(bad,"4010800",name));
  assert.equal(downloadWindowStart("d7",end),"2026-09-16");
  assert.equal(downloadWindowStart("d30",end),"2026-08-24");
  assert.equal(downloadWindowStart("d90",end),"2026-06-25");
  assert.equal(downloadWindowStart("m12",end),"2025-09-23");
  assert.equal(downloadWindowStart("ltd",end),"2000-01-01");
});
test("actuals refresh requires a valid ops token or human auth; reads are not made public", async () => {
  const saved={mode:process.env.AUTH_MODE,secret:process.env.SABER_AUTH_JWT_SECRET,ops:process.env.INGESTION_OPS_TOKEN};
  let server:any;
  try {
    process.env.AUTH_MODE="saber";process.env.SABER_AUTH_JWT_SECRET="fixture-jwt-secret";
    process.env.INGESTION_OPS_TOKEN="fixture-ops-token";
    const express=(await import("express")).default,app=express();
    app.use((await import("../../saber-auth")).createSaberAuthMiddleware().middleware);
    const route="/api/ops/demos-download-actuals-refresh";
    app.post(route,(_req,res)=>res.json({ok:true}));
    app.get("/api/demos/leaderboard",(_req,res)=>res.json({ok:true}));
    server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base+route,{method:"POST"})).status,401);
    assert.equal((await fetch(base+route,{method:"POST",headers:{"x-ops-token":"incorrect"}})).status,401);
    assert.equal((await fetch(base+route,{method:"POST",headers:{"x-ops-token":"fixture-ops-token"}})).status,200);
    assert.equal((await fetch(base+"/api/demos/leaderboard")).status,401);
    assert.equal((await fetch(base+"/api/demos/leaderboard",{headers:{"x-ops-token":"fixture-ops-token"}})).status,401);
  } finally {
    if(server)await new Promise<void>(r=>server.close(r));
    for(const [key,value] of Object.entries({AUTH_MODE:saved.mode,SABER_AUTH_JWT_SECRET:saved.secret,INGESTION_OPS_TOKEN:saved.ops}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
test("collector, real HTTP leaderboard, dashboard mapping, zeroes, stale failures and source isolation", async () => {
  const cwd=process.cwd(), dir=mkdtempSync(join(tmpdir(),"demo-actuals-")), realFetch=globalThis.fetch;
  process.chdir(dir);
  let db:any, server:any;
  try {
    const storageModule=await import("../../storage"); db=storageModule.rawSqlite;
    const { SABER_DEMO_ROSTER, seedSaberDemos }=await import("./saber-seed"); seedSaberDemos();
    const stamp=new Date().toISOString();
    storageModule.storage.upsertSteamworksSession({id:"default",cookieValue:"fixture-cookie"});
    const requests:string[]=[];
    let fail=false;
    globalThis.fetch=async input=>{
      const url=new URL(String(input)); requests.push(url.href);
      if(fail) return new Response("Login",{status:302,headers:{Location:"https://example.invalid"}});
      const demo=SABER_DEMO_ROSTER.find(d=>d.steamAppId===url.searchParams.get("appID"));
      assert.ok(demo, "Only approved demo App IDs, never parent purchases or competitors");
      assert.equal(url.pathname,"/nav_regions.php"); assert.equal(url.searchParams.get("downloads"),"1");
      const start=url.searchParams.get("dateStart")??"2000-01-01";
      const total=start==="2000-01-01" ? "128,512" : start==="2026-09-16" ? "0" : "353";
      return new Response(html(demo.name,total,start,demo.steamAppId));
    };
    const { refreshDashboardDemoActuals }=await import("./download-actuals");
    const p=refreshDashboardDemoActuals(); assert.equal(p,refreshDashboardDemoActuals(),"single-flight");
    const result=await p; assert.equal(result.succeeded,6); assert.equal(result.failed,0);
    assert.equal(requests.length,36);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_download_actuals").get().n,30);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM steam_sales_daily").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_portal_daily").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_window_estimates_daily").get().n,0);
    const { loadDashboardDemoDownloads }=await import("./dashboard");
    const products=[{id:10,steamAppId:"2157830",isSaberPublished:false},{id:15,steamAppId:"2487300",isSaberPublished:true}];
    const cards=loadDashboardDemoDownloads(products);
    assert.equal(cards.get(10)?.[0].demoAppId,"4354730");
    assert.equal(cards.get(10)?.[0].lifetimeDownloads,128512);
    assert.equal(cards.get(10)?.[0].isArchived,true);
    assert.equal(cards.get(15)?.[0].lifetimeDownloads,128512);
    assert.equal(loadDashboardDemoDownloads([...products,{id:16,steamAppId:"2487300"}]).has(15),false,"ambiguous parent fails closed");
    // Public estimate pollution must not override Saber actuals.
    const demoId=db.prepare("SELECT id FROM demo_titles WHERE steam_app_id='4010800'").get().id;
    db.prepare(`INSERT INTO demo_window_estimates_daily (demo_title_id,window,as_of_date,units_mid,review_delta,method,created_at)
      VALUES (?,'d7',?,999999,9999,'steamworks_actual',?)`).run(demoId,stamp.slice(0,10),stamp);
    db.prepare("INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES(?,?,9999999)").run(demoId,stamp);
    db.prepare(`INSERT INTO demo_titles(steam_app_id,name,discovered_via,is_active,first_seen_at,created_at,updated_at)
      VALUES('999','Competitor Demo','test',1,?,?,?)`).run(stamp,stamp,stamp);
    const other=db.prepare("SELECT id FROM demo_titles WHERE steam_app_id='999'").get().id;
    for(const window of DEMO_ACTUAL_WINDOWS) db.prepare(`INSERT INTO demo_window_estimates_daily
      (demo_title_id,window,as_of_date,units_mid,review_delta,method,created_at)
      VALUES (?,?,?,655,10,'review_delta_multiplier',?)`).run(other,window,stamp.slice(0,10),stamp);
    const express=(await import("express")).default;
    const app=express(); (await import("../../routes-demos-leaderboard")).registerDemosLeaderboardRoutes(app);
    app.get("/cards",(_req,res)=>res.json(Object.fromEntries(loadDashboardDemoDownloads(products))));
    server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve));
    for(const window of DEMO_ACTUAL_WINDOWS) for(const direction of ["asc","desc"]) {
      const body=await(await realFetch(`http://127.0.0.1:${server.address().port}/api/demos/leaderboard?window=${window}&direction=${direction}`)).json();
      const own=body.demos.find((d:any)=>d.steamAppId==="4010800"), comp=body.demos.find((d:any)=>d.steamAppId==="999");
      assert.equal(own.unitsMid,window==="ltd"?128512:window==="d7"?0:353);
      assert.equal(own.method,"steamworks_actual"); assert.equal(own.downloadMultiplier,null); assert.equal(own.isObservedMinimum,false);
      assert.equal(comp.unitsMid,1300); assert.equal(comp.calibrationMode,"non_saber_trial");
      const values=body.demos.map((d:any)=>d.unitsMid).filter((n:any)=>n!==null);
      assert.deepEqual(values,[...values].sort((a,b)=>direction==="asc"?a-b:b-a));
    }
    fail=true; const failed=await refreshDashboardDemoActuals(); assert.equal(failed.failed,6);
    assert.equal(db.prepare("SELECT downloads FROM demo_download_actuals WHERE steam_app_id='4010800' AND window='d7'").get().downloads,0);
    assert.equal(loadDashboardDemoDownloads(products).get(15)?.[0].refreshFailed,true);
    db.prepare("UPDATE demo_download_actuals SET fetched_at='2020-01-01T00:00:00Z'").run();
    assert.equal(loadDashboardDemoDownloads(products).get(15)?.[0].isStale,true);
    db.prepare("DELETE FROM demo_download_actuals WHERE steam_app_id='4010800'").run();
    const missing=await(await realFetch(`http://127.0.0.1:${server.address().port}/api/demos/leaderboard?window=d7`)).json();
    const missingOwn=missing.demos.find((d:any)=>d.steamAppId==="4010800");
    assert.equal(missingOwn.unitsMid,null,"no license, review, or CCU fallback for Saber");
    assert.equal(loadDashboardDemoDownloads(products).get(15)?.[0].valueKind,"unavailable");
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
  } finally {globalThis.fetch=realFetch;if(server)await new Promise<void>(r=>server.close(r));db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});}
});
