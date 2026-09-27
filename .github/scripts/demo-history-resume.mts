/** Operator-only continuation: never plan/enroll/reset any job. */
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
const require=createRequire(resolve("package.json"));
const Database=require("better-sqlite3");
const load=(file:string)=>import(pathToFileURL(resolve(file)).href);
const {HistoryBudget,runHistoryBackfill}=await load("server/signals/demos/history-backfill.ts");
const {SABER_DEMO_ROSTER}=await load("server/signals/demos/saber-roster.ts");
const {isFriendsPassSku}=await load("server/signals/demos/friends-pass-identity.ts");
const [maxRequests,maxMs]=process.argv.slice(2).map(Number);
if(process.env.DEMO_HISTORY_MAINTENANCE_LOCK!=="1"||
  !Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>200||
  !Number.isSafeInteger(maxMs)||maxMs<1000||maxMs>240000)
  throw Error("Approved bounded maintenance workflow required");
const db=new Database(process.env.DEMO_HISTORY_DB??"data.db",{fileMustExist:true});
try{
  const jobsBefore=db.prepare(`SELECT steam_app_id,kind,start_date,end_date FROM demo_history_backfill_jobs
    ORDER BY steam_app_id,kind`).all();
  if(!jobsBefore.length||jobsBefore.some((j:any)=>j.start_date!=="2025-01-01"||j.end_date!=="2026-09-25"))
    throw Error("Existing scope mismatch");
  const approved=new Set(SABER_DEMO_ROSTER.map((t:any)=>t.steamAppId));
  const titles=db.prepare(`SELECT steam_app_id,name,is_saber_published,release_date FROM demo_titles t
    WHERE sku_kind='demo' AND tracking_excluded_reason IS NULL
    AND EXISTS(SELECT 1 FROM demo_history_backfill_jobs j WHERE j.steam_app_id=t.steam_app_id)
    ORDER BY is_saber_published DESC,name`).all().filter((t:any)=>
      !isFriendsPassSku(t.steam_app_id,t.name)&&(!t.is_saber_published||approved.has(t.steam_app_id)));
  const cookie=db.prepare("SELECT cookie_value FROM steamworks_sessions WHERE id='default'").get()?.cookie_value;
  const result=await runHistoryBackfill(db,titles,approved,cookie,new HistoryBudget(maxRequests,maxMs),"all");
  const jobsAfter=db.prepare(`SELECT steam_app_id,kind,start_date,end_date FROM demo_history_backfill_jobs
    ORDER BY steam_app_id,kind`).all();
  if(JSON.stringify(jobsBefore)!==JSON.stringify(jobsAfter))throw Error("Job scope unexpectedly changed");
  console.log(JSON.stringify({result,enrolledJobsUnchanged:true,eligibleExistingTitles:titles.length}));
}finally{db.close();}
