const fs=require("node:fs"),crypto=require("node:crypto"),{execFileSync}=require("node:child_process");
const Database=require(process.cwd()+"/node_modules/better-sqlite3");
const phase=process.argv[2],expected=process.argv[3],assert=(v,m)=>{if(!v)throw Error(m);};
const prefix="/tmp/demo-review-priority-sep28";
const db=new Database("data.db",{readonly:true});
const head=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const schedulerHash=crypto.createHash("sha256").update(fs.readFileSync("server/ingestion.ts")).digest("hex");
const tables=["demo_titles","demo_download_actuals","demo_download_observations","demo_window_estimates_daily","steam_review_history","demo_ccu_snapshots","demo_ccu_daily_peaks","demo_download_dated_reports"];
const rowHash=row=>crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
function protectedJobs(conn){
  return conn.prepare("SELECT * FROM demo_history_backfill_jobs WHERE kind='downloads' OR status IN ('complete','mismatch') ORDER BY steam_app_id,kind")
    .all().map(row=>({appId:row.steam_app_id,kind:row.kind,sha256:rowHash(row)}));
}
function fingerprints(conn,columns){
  return Object.fromEntries(tables.map(table=>{
    const cols=columns?.[table]??conn.pragma(`table_info(${table})`).map(c=>c.name);
    const hash=crypto.createHash("sha256");let rows=0;
    for(const row of conn.prepare(`SELECT ${cols.map(c=>`"${c}"`).join(",")} FROM ${table} ORDER BY rowid`).iterate()){
      hash.update(JSON.stringify(row)+"\n");rows++;
    }
    return [table,{columns:cols,rows,sha256:hash.digest("hex")}];
  }));
}
async function verify(){
  const before=JSON.parse(fs.readFileSync(prefix+"-baseline.json","utf8"));
  assert(head===expected,"Production HEAD mismatch");
  assert(schedulerHash===before.schedulerHash,"Daily scheduler source changed");
  assert(execFileSync("systemctl",["is-active","signalpulse"],{encoding:"utf8"}).trim()==="active","Service inactive");
  assert(db.pragma("integrity_check",{simple:true})==="ok","Database integrity failed");
  const columns=Object.fromEntries(Object.entries(before.fingerprints).map(([t,r])=>[t,r.columns]));
  const after=fingerprints(db,columns),preserved=Object.fromEntries(tables.map(t=>[t,after[t].sha256===before.fingerprints[t].sha256]));
  assert(Object.values(preserved).every(Boolean),"Original demo data changed; inspect before proceeding");
  const unchangedJobs=before.protectedJobs.every(j=>{
    const row=db.prepare("SELECT * FROM demo_history_backfill_jobs WHERE steam_app_id=? AND kind=?").get(j.appId,j.kind);
    return row&&rowHash(row)===j.sha256;
  });
  assert(unchangedJobs,"Protected download/completed/mismatch job changed");
  const jwt=require(process.cwd()+"/node_modules/jsonwebtoken");
  assert(process.env.SABER_AUTH_JWT_SECRET,"Server auth configuration unavailable");
  const token=jwt.sign({sub:"deployment-verification-pr156",email:"deployment-verification@localhost",scopes:["signalpulse"],
    is_admin:false,jti:crypto.randomUUID()},process.env.SABER_AUTH_JWT_SECRET,{expiresIn:180});
  const get=async(path,auth=true)=>{
    const r=await fetch("http://127.0.0.1:5000"+path,{signal:AbortSignal.timeout(20000),
      headers:auth?{Authorization:"Bearer "+token}:{}});
    return {status:r.status,body:await r.json()};
  };
  assert((await get("/api/demos/titles/5184670",false)).status===401,"PDP authentication regressed");
  assert((await get("/api/demos/archive",false)).status===401,"Archive authentication regressed");
  const checked=[];
  for(const appId of ["5184670","4010800","4354730","3462370","4010830","4047990","5166840","5075680"]){
    const r=await get(`/api/demos/titles/${appId}?days=all`);assert(r.status===200,"Tracked PDP unavailable");
    const v=r.body;
    assert(v.rows.every(row=>Object.hasOwn(row,"netLifetimeChange")&&Object.hasOwn(row,"reportedDownloadsToDate")),"Dated schema missing");
    assert(v.historyCoverage&&Array.isArray(v.historyCoverage.jobs),"Coverage contract missing");
    if(v.isSaber){
      const stored=db.prepare("SELECT downloads FROM demo_download_actuals WHERE steam_app_id=? AND window='ltd'").get(appId);
      assert(v.latest.downloads===stored.downloads,"Headline changed to historical report");
    }
    checked.push({appId,name:v.name,isSaber:v.isSaber,archived:v.archived,latestDownloads:v.latest.downloads,
      coverage:v.historyCoverage,firstDate:v.firstHistoryDate,
      dailyReportPoints:v.rows.filter(r=>r.dailyReportFetchedAt).length,
      reportedToDatePoints:v.rows.filter(r=>r.cumulativeReportFetchedAt).length});
  }
  const html=fs.readFileSync("dist/public/index.html","utf8");
  const asset=html.match(/src="\/signal\/assets\/([^"]+\.js)"/)?.[1];assert(asset,"Built app asset missing");
  const js=fs.readFileSync("dist/public/assets/"+asset,"utf8");
  assert(js.includes("Reported through date")&&js.includes("History coverage")&&js.includes("netLifetimeChange"),"Built UI missing");
  return {head,backup:before.backup,integrity:"ok",preserved,unchangedProtectedJobs:unchangedJobs,protectedJobCount:before.protectedJobs.length,schedulerHash,scheduler:"03:00 America/New_York, unchanged",checked,asset};
}
function coverage(){
  const titles=db.prepare(`SELECT t.steam_app_id appId,t.name,t.is_saber_published isSaber,t.is_active isActive,
    t.release_date releaseDate,t.deactivated_at retiredAt,t.sku_kind skuKind,t.tracking_excluded_reason trackingExcludedReason,
    (SELECT COUNT(*) FROM demo_download_dated_reports d WHERE d.steam_app_id=t.steam_app_id AND d.scope='day') dailyReportDays,
    (SELECT MIN(report_date) FROM demo_download_dated_reports d WHERE d.steam_app_id=t.steam_app_id AND d.scope='day') firstDailyReport,
    (SELECT MAX(report_date) FROM demo_download_dated_reports d WHERE d.steam_app_id=t.steam_app_id AND d.scope='day') lastDailyReport,
    (SELECT COUNT(*) FROM demo_download_dated_reports d WHERE d.steam_app_id=t.steam_app_id AND d.scope='to_date') cumulativeReportDays,
    (SELECT COUNT(*) FROM demo_download_observations d WHERE d.steam_app_id=t.steam_app_id AND d.window='ltd') observedLifetimeDays,
    (SELECT COUNT(*) FROM steam_review_history h WHERE h.app_id=t.steam_app_id AND h.bucket_granularity='day') histogramDays,
    (SELECT COUNT(*) FROM demo_review_recovered_daily r WHERE r.steam_app_id=t.steam_app_id) recoveredReviewDays,
    (SELECT COUNT(*) FROM demo_review_backfill_items r WHERE r.steam_app_id=t.steam_app_id) retrievedReviewRecords
    FROM demo_titles t WHERE EXISTS(SELECT 1 FROM demo_history_backfill_jobs j WHERE j.steam_app_id=t.steam_app_id)
    ORDER BY t.is_saber_published DESC,t.name`).all();
  const jobs=db.prepare(`SELECT steam_app_id appId,kind,start_date startDate,end_date endDate,next_date nextDate,
    status,pages,expected_reviews expectedReviews,started_at startedAt,updated_at updatedAt,error
    FROM demo_history_backfill_jobs ORDER BY kind,steam_app_id`).all();
  const stats=db.prepare("SELECT kind,status,COUNT(*) titles FROM demo_history_backfill_jobs GROUP BY kind,status").all();
  const actualSamples=db.prepare(`SELECT * FROM demo_download_dated_reports WHERE steam_app_id='5184670' ORDER BY report_date DESC,scope`).all();
  return {observedAt:new Date().toISOString(),head,since:"2025-01-01",until:"2026-09-25",titles,jobs,stats,actualSamples};
}
function chronologicalMarkers(text){
  return text.split("\n").filter(l=>l.trim()).map(l=>{
    const e=JSON.parse(l);
    if(typeof e.MESSAGE!=="string"||!/^\d+$/.test(e.__REALTIME_TIMESTAMP))throw Error("Invalid journal marker");
    return {message:e.MESSAGE,at:new Date(Number(e.__REALTIME_TIMESTAMP)/1000).toISOString(),time:Number(e.__REALTIME_TIMESTAMP)};
  }).sort((a,b)=>a.time-b.time);
}
async function safeToResume(){
  assert(process.env.INGESTION_OPS_TOKEN,"Server ops configuration unavailable");
  const r=await fetch("http://127.0.0.1:5000/api/ingestion/status",{
    headers:{"x-ops-token":process.env.INGESTION_OPS_TOKEN},signal:AbortSignal.timeout(15000)});
  assert(r.status===200,"Ingestion status unavailable");
  const status=await r.json();
  assert(status.inFlight===false&&status.status!=="running","Manual ingestion active");
  const journal=execFileSync("journalctl",["-u","signalpulse","--since","24 hours ago","-o","json","--no-pager",
    "--grep","Starting daily ingestion run|Ingestion complete[.]|Ingestion cron error:|Demos pipeline: (released|eligible=)","-n","100"],
    {encoding:"utf8",maxBuffer:16*1024*1024});
  const markers=chronologicalMarkers(journal);
  const daily=markers.filter(l=>l.message.includes("[ingestion]")&&
    /Starting daily ingestion run|Ingestion complete\.|Ingestion cron error:/.test(l.message));
  const demos=markers.filter(l=>l.message.includes("[demos-pipeline]")&&
    /Demos pipeline: released|Demos pipeline: eligible=/.test(l.message));
  console.log(JSON.stringify({phase:"ingestion-safety-check",manualInFlight:status.inFlight,lastRun:status.lastRun,
    lastRunStartedAt:status.lastResult?.startedAt,lastRunCompletedAt:status.lastResult?.completedAt,
    dailyMarkers:daily.map(l=>({at:l.at,event:l.message.includes("Starting daily")?"started":l.message.includes("Ingestion complete.")?"completed":"error"})),
    demoMarkers:demos.map(l=>({at:l.at,event:l.message.includes("eligible=")?"completed":"started"})),
    rawMarkerCount:markers.length}));
  assert(daily.length&&!daily.at(-1).message.includes("Starting daily ingestion run"),"Daily ingestion may still be active");
  assert(demos.length&&demos.at(-1).message.includes("Demos pipeline: eligible="),"Demo pipeline may still be active");
  const previous=JSON.parse(fs.readFileSync("/tmp/demo-history-resume-sep27-window.json","utf8"));
  assert(previous.status==="stopped","Previous work window not stopped");
  assert(!fs.existsSync(prefix+"-window.json"),"This authorized continuation already started; inspect rather than replay");
  const scopes=db.prepare("SELECT DISTINCT start_date,end_date FROM demo_history_backfill_jobs").all();
  assert(scopes.length===1&&scopes[0].start_date==="2025-01-01"&&scopes[0].end_date==="2026-09-25","Backfill scope drift");
  assert(db.prepare("SELECT COUNT(*) n FROM demo_history_backfill_jobs WHERE kind='downloads'").get().n===6,"Saber scope drift");
  return {manualInFlight:status.inFlight,lastCompletedIngestion:status.lastRun,
    dailyRunHasTerminalMarker:true,demoPipelineHasCompletionMarker:true,previousWindowStopped:true};
}
async function main(){
  assert(/^[a-f0-9]{40}$/.test(expected)&&head===expected,`Expected approved production SHA mismatch; actual ${head}`);
  if(phase==="inspect"){
    const safety=await safeToResume(),report=coverage();
    console.log(JSON.stringify({phase,head,safety,stats:report.stats,titleCount:report.titles.length,
      eligibleCatalog:db.prepare("SELECT COUNT(*) n FROM demo_titles WHERE sku_kind='demo' AND tracking_excluded_reason IS NULL").get().n}));
    return;
  }
  if(phase==="backup"){
    const safety=await safeToResume();
    assert(!fs.existsSync(prefix+"-baseline.json"),"Baseline exists; do not replace approved continuation evidence");
    const disk=fs.statfsSync("."),size=fs.statSync("data.db").size;
    assert(disk.bavail*disk.bsize>size+128*1024*1024,"Insufficient backup space");
    process.umask(0o077);
    const backup=`/opt/sentimentpulse/signalpulse/data.pre-demo-review-priority-sep28.${new Date().toISOString().replace(/[:.]/g,"-")}.db`;
    await db.backup(backup);fs.chmodSync(backup,0o600);
    const saved=new Database(backup,{readonly:true}),integrity=saved.pragma("integrity_check",{simple:true});
    assert(integrity==="ok","Backup integrity failed");
    const baseline={phase,head,backup,integrity,schedulerHash,fingerprints:fingerprints(saved),
      protectedJobs:protectedJobs(saved),at:new Date().toISOString(),safety};saved.close();
    fs.writeFileSync(prefix+"-before.json",JSON.stringify(coverage()),{mode:0o600});
    fs.writeFileSync(prefix+"-baseline.json",JSON.stringify(baseline),{mode:0o600});
    const {protectedJobs:protectedJobRows,...safeBaseline}=baseline;
    console.log(JSON.stringify({...safeBaseline,protectedJobCount:protectedJobRows.length}));return;
  }
  if(phase==="verify"){console.log(JSON.stringify({phase,ok:true,...await verify()}));return;}
  if(phase==="backfill"){
    await safeToResume();
    console.log(JSON.stringify({phase:"pre-backfill-verification",ok:true,...await verify()}));
    await require("/tmp/demo-history-bounded.cjs").run(expected);
  }
  const verification=await verify(),report=coverage();
  fs.writeFileSync(prefix+"-coverage.json",JSON.stringify({...report,verification}),{mode:0o600});
  console.log(JSON.stringify({phase,ok:true,stats:report.stats,titleCount:report.titles.length,verification}));
}
main().catch(e=>{console.error("Approved operation failed:",e.message);process.exitCode=1;}).finally(()=>db.close());
