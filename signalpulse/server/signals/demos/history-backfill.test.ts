import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {initializeDemoHistory} from "./history-schema";
import {HistoryBudget,planHistoryBackfill,runHistoryBackfill,refreshRecentDemoReports,completedReportDay} from "./history-backfill";
import {DOWNLOAD_DEFINITION,parseDatedDownloadReport,parseDownloadReport} from "./download-report";
import {loadDemoHistory} from "./history";

const own={steam_app_id:"5184670",name:"Verified Demo",is_saber_published:1,release_date:"2026-09-17"};
const other={steam_app_id:"3426800",name:"Other Demo",is_saber_published:0,release_date:null};
const approved=new Set([own.steam_app_id]);
function fixture(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE demo_download_actuals(steam_app_id,window,downloads,report_start_date,report_end_date,fetched_at,source);
    CREATE TABLE demo_titles(id INTEGER PRIMARY KEY,steam_app_id TEXT,name TEXT);
    CREATE TABLE demo_window_estimates_daily(demo_title_id,window,as_of_date,units_mid,method,multiplier_id,review_count_total);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,created_at);
    CREATE TABLE demo_ccu_snapshots(id,demo_title_id,captured_at,ccu);
    CREATE TABLE demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu);`);
  db.prepare("INSERT INTO demo_titles VALUES(1,?,?)").run(own.steam_app_id,own.name);
  db.prepare("INSERT INTO demo_titles VALUES(2,?,?)").run(other.steam_app_id,other.name);
  initializeDemoHistory(db);return db;
}
const report=(start:string,end:string,total:number,name=own.name,id=own.steam_app_id)=>`<h1>Game: ${name} - Downloads by Region</h1>
  <a href="/nav_regions.php?downloads=1&amp;appID=${id}&amp;dateStart=2000-01-01&amp;dateEnd=2026-09-25">all history</a>
  <input name="dateStart" value="${start}"><input name="dateEnd" value="${end}">
  <p>${DOWNLOAD_DEFINITION}</p><div>Total Downloads: ${total}</div>`;
const fakeReport:typeof fetch=async input=>{
  const u=new URL(String(input)),start=u.searchParams.get("dateStart")??"2000-01-01",end=u.searchParams.get("dateEnd")??"2026-09-25";
  return new Response(report(start,end,start==="2000-01-01"?35290:end==="2026-09-17"?16699:18536));
};
const budget=(n:number,transport:typeof fetch)=>new HistoryBudget(n,20000,0,transport);
test("dated report has exact identity/dates/definition; cannot relax legacy lifetime parser",()=>{
  const html=report("2000-01-01","2026-09-18",35290);
  assert.equal(parseDatedDownloadReport(html,own.name,"2000-01-01","2026-09-18"),35290);
  assert.throws(()=>parseDownloadReport(html,own.name,"2000-01-01","2026-09-18"),/Lifetime scope/);
  for(const bad of [html.replace(own.name,"Parent game"),html.replace(DOWNLOAD_DEFINITION,"Complimentary units"),
    html.replace('value="2026-09-18"','value="2026-09-19"'),html+"<div>Total Downloads: 1</div>"])
    assert.throws(()=>parseDatedDownloadReport(bad,own.name,"2000-01-01","2026-09-18"));
  assert.throws(()=>parseDatedDownloadReport(html,own.name,"2026-02-30","2026-09-18"));
});
test("Saber backfill resumes mid-date, is idempotent, retains separate series and never seeds past snapshots",async()=>{
  const db=fixture();
  const plan=planHistoryBackfill(db,[own,other],approved,"2026-09-17","2026-09-18","all",false);
  assert.equal(plan.length,3);assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_history_backfill_jobs").get() as any).n,0);
  planHistoryBackfill(db,[own],approved,"2026-09-17","2026-09-18","saber",true);
  const first=await runHistoryBackfill(db,[own],approved,"fixture",budget(2,fakeReport));
  assert.equal(first.budgetLimited,true);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports").get() as any).n,1);
  assert.equal((db.prepare("SELECT next_date FROM demo_history_backfill_jobs").get() as any).next_date,"2026-09-18");
  await runHistoryBackfill(db,[own],approved,"fixture",budget(10,fakeReport));
  assert.equal((db.prepare("SELECT status FROM demo_history_backfill_jobs").get() as any).status,"complete");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports").get() as any).n,4);
  assert.equal((await runHistoryBackfill(db,[own],approved,"fixture",budget(10,fakeReport))).requests,0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_download_observations").get() as any).n,0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_download_actuals").get() as any).n,0);
  const rows=loadDemoHistory(db,{id:1,...own,is_active:0},"all","2026-09-18").rows;
  assert.deepEqual(rows.map(r=>r.dailyDownloads),[16699,18536]);
  assert.equal(rows[1].reportedDownloadsToDate,35290);
  assert.notEqual(rows.reduce((n,r)=>n+r.dailyDownloads!,0),rows[1].reportedDownloadsToDate);
  assert.ok(rows.every(r=>r.lifetimeDownloads===null&&r.netLifetimeChange===null));
  assert.throws(()=>planHistoryBackfill(db,[own],approved,"2026-09-16","2026-09-18","saber",true),/different date scope/);
  db.close();
});
test("budget/time/throttle and wrong-App-ID boundaries fail closed without zero or cookie leakage",async()=>{
  for(const transport of [
    async()=>new Response("secret fixture-cookie",{status:429}),
    async()=>new Response("secret fixture-cookie",{status:302}),
    async()=>new Response(report("2026-09-18","2026-09-18",0,own.name,"1551980"))
  ] as typeof fetch[]){
    const db=fixture();planHistoryBackfill(db,[own],approved,"2026-09-18","2026-09-18","saber",true);
    const result=await runHistoryBackfill(db,[own],approved,"fixture-cookie",budget(10,transport));
    assert.equal(result.requests,1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports").get() as any).n,0);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM demo_history_backfill_jobs").all()).includes("fixture-cookie"));
    db.close();
  }
  const db=fixture();planHistoryBackfill(db,[own],approved,"2026-09-18","2026-09-18","saber",true);
  assert.equal((await runHistoryBackfill(db,[own],new Set(),"fixture",budget(10,fakeReport))).requests,0);
  db.close();
});
const review=(id:number,date:string,positive=true)=>({recommendationid:String(id),timestamp_created:Date.parse(date)/1000,voted_up:positive,
  review:"This text must never be retained",author:{steamid:"secret-author"}});
test("review paging checkpoints atomically, deduplicates IDs and only publishes reconciled activity dates",async()=>{
  const db=fixture();planHistoryBackfill(db,[other],approved,"2025-01-01","2026-09-25","reviews",true);
  const transport:typeof fetch=async input=>{
    const cursor=new URL(String(input)).searchParams.get("cursor");
    return Response.json(cursor==="*"?{success:1,query_summary:{total_reviews:2},cursor:"next",reviews:[review(1,"2025-02-07")]}
      :cursor==="next"?{success:1,cursor:"end",reviews:[review(1,"2025-02-07"),review(2,"2025-02-08",false)]}
      :{success:1,cursor:"end",reviews:[]});
  };
  await runHistoryBackfill(db,[other],approved,undefined,budget(1,transport));
  assert.equal((db.prepare("SELECT cursor FROM demo_history_backfill_jobs").get() as any).cursor,"next");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_review_recovered_daily").get() as any).n,0);
  await runHistoryBackfill(db,[other],approved,undefined,budget(5,transport));
  assert.equal((db.prepare("SELECT status FROM demo_history_backfill_jobs").get() as any).status,"complete");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_review_backfill_items").get() as any).n,2);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM demo_review_backfill_items").all()).includes("secret-author"));
  const rows=loadDemoHistory(db,{id:2,...other,is_active:1},"all","2025-02-08").rows;
  assert.deepEqual(rows.map(r=>r.dailyDownloads),[130,130]);
  assert.ok(rows.every(r=>r.totalReviews===null&&r.lifetimeDownloads===null&&r.reviewActivitySource==="steam:appreviews:created-date"));
  db.prepare("INSERT INTO steam_review_history VALUES(?,?,?,?,?,?)")
    .run(other.steam_app_id,Date.parse("2025-02-07")/1000,"day",3,0,"2026-09-26");
  assert.equal(loadDemoHistory(db,{id:2,...other,is_active:1},"all","2025-02-08").rows[0].dailyDownloads,390,"Valve histogram wins");
  db.close();
});
test("incomplete, mismatched and zeroed retired pagination never publishes recovered estimates",async()=>{
  for(const mode of ["mismatch","stalled","zeroed","invalid"]){
    const db=fixture();planHistoryBackfill(db,[other],approved,"2025-01-01","2026-09-25","reviews",true);
    if(mode==="zeroed")db.prepare("INSERT INTO demo_window_estimates_daily VALUES(2,'ltd','2026-09-22',130,'review_delta_multiplier','trial',1)").run();
    const transport:typeof fetch=async input=>{
      const cursor=new URL(String(input)).searchParams.get("cursor");
      const reviews=mode==="zeroed"||cursor==="end"?[]:[review(1,mode==="invalid"?"1900-01-01":"2025-02-07")];
      return Response.json({success:1,query_summary:{total_reviews:mode==="mismatch"?5:mode==="zeroed"?0:1},
        cursor:mode==="stalled"?"*":"end",reviews});
    };
    await runHistoryBackfill(db,[other],approved,undefined,budget(5,transport));
    assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_review_recovered_daily").get() as any).n,0);
    assert.ok(["mismatch","error"].includes((db.prepare("SELECT status FROM demo_history_backfill_jobs").get() as any).status));
    db.close();
  }
});
test("matching review-summary totals still fail publication when fresh histogram overlap disagrees",async()=>{
  const db=fixture(),day=completedReportDay(),fetched=new Date().toISOString();
  planHistoryBackfill(db,[other],approved,"2025-01-01",day,"reviews",true);
  db.prepare("INSERT INTO steam_review_history VALUES(?,?,?,?,?,?)")
    .run(other.steam_app_id,Date.parse(day)/1000,"day",2,0,fetched);
  const transport:typeof fetch=async input=>Response.json({
    success:1,query_summary:{total_reviews:1},cursor:"end",
    reviews:new URL(String(input)).searchParams.get("cursor")==="*"?[review(1,day)]:[],
  });
  await runHistoryBackfill(db,[other],approved,undefined,budget(5,transport));
  assert.equal((db.prepare("SELECT status FROM demo_history_backfill_jobs").get() as any).status,"mismatch");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM demo_review_recovered_daily").get() as any).n,0);
  assert.equal((db.prepare("SELECT recommendations_up n FROM steam_review_history").get() as any).n,2);
  db.close();
});
test("daily job collects direct recent reports for approved retired demos; no competitor reports or new schedule",async()=>{
  const db=fixture(),urls:string[]=[];
  const recent:typeof fetch=async input=>{
    const u=new URL(String(input));urls.push(u.href);
    return new Response(report(u.searchParams.get("dateStart")??"2000-01-01",u.searchParams.get("dateEnd")??"2026-09-25",0));
  };
  const result=await refreshRecentDemoReports(db,[own,other],approved,"fixture",budget(48,recent),"2026-09-26");
  assert.equal(result.succeeded,1);assert.equal(result.rowsWritten,6);assert.equal(urls.length,7);
  assert.ok(urls.every(u=>new URL(u).searchParams.get("appID")===own.steam_app_id));
  const before=db.prepare("SELECT * FROM demo_download_dated_reports").all();
  await refreshRecentDemoReports(db,[own],approved,"fixture",budget(48,async()=>new Response("login",{status:403})),"2026-09-26");
  assert.deepEqual(db.prepare("SELECT * FROM demo_download_dated_reports").all(),before);
  assert.ok(completedReportDay()<new Date().toISOString().slice(0,10));db.close();
});
