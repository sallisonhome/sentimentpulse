/**
 * Default: read-only plan, no network calls or schema initialization.
 * Apply only after production backup + explicit operator approval.
 * Run under /run/lock/signalpulse-maintenance.lock on the production host.
 */
import Database from "better-sqlite3";
import {SABER_DEMO_ROSTER} from "../server/signals/demos/saber-roster";
import {isFriendsPassSku} from "../server/signals/demos/friends-pass-identity";
import {HistoryBudget,planHistoryBackfill,runHistoryBackfill,type HistoryTitle} from "../server/signals/demos/history-backfill";
const args=process.argv.slice(2);
const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const apply=args.includes("--apply"),since=value("--since"),until=value("--until"),scope=value("--scope")??"all";
const maxRequests=Number(value("--max-requests")??200),maxMs=Number(value("--max-ms")??240000);
if(!since||!until||!["all","saber","reviews"].includes(scope)||!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>5000||
  !Number.isSafeInteger(maxMs)||maxMs<1000||maxMs>3600000)
  throw Error("Required: --since YYYY-MM-DD --until YYYY-MM-DD [--scope all|saber|reviews] [--apply] [--max-requests 1..5000] [--max-ms 1000..3600000]");
if(apply&&process.env.DEMO_HISTORY_MAINTENANCE_LOCK!=="1")throw Error("Apply requires the approved maintenance-lock workflow");
const db=new Database(process.env.DEMO_HISTORY_DB??"data.db",{readonly:!apply,fileMustExist:true});
try{
  const approved=new Set(SABER_DEMO_ROSTER.map(t=>t.steamAppId));
  const titles=(db.prepare(`SELECT steam_app_id,name,is_saber_published,release_date FROM demo_titles
    WHERE sku_kind='demo' AND tracking_excluded_reason IS NULL ORDER BY is_saber_published DESC,name`).all() as HistoryTitle[])
    .filter(t=>!isFriendsPassSku(t.steam_app_id,t.name)&&(t.is_saber_published!==1||approved.has(t.steam_app_id)));
  const plan=planHistoryBackfill(db,titles,approved,since,until,scope as any,apply);
  const cookie=apply?(db.prepare("SELECT cookie_value FROM steamworks_sessions WHERE id='default'").get() as any)?.cookie_value:undefined;
  const result=apply?await runHistoryBackfill(db,titles,approved,cookie,new HistoryBudget(maxRequests,maxMs),scope as any):null;
  const jobs=db.prepare(`SELECT steam_app_id,kind,start_date,end_date,status,pages,expected_reviews,next_date,error,updated_at
    FROM demo_history_backfill_jobs ORDER BY kind,steam_app_id`).all();
  const coverage=titles.map(t=>({
    appId:t.steam_app_id,name:t.name,isSaber:t.is_saber_published===1,
    dailyReportDays:(db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports WHERE steam_app_id=? AND scope='day'").get(t.steam_app_id) as any).n,
    cumulativeReportDays:(db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports WHERE steam_app_id=? AND scope='to_date'").get(t.steam_app_id) as any).n,
    histogramDays:(db.prepare("SELECT COUNT(*) n FROM steam_review_history WHERE app_id=? AND bucket_granularity='day'").get(t.steam_app_id) as any).n,
    recoveredReviewDays:(db.prepare("SELECT COUNT(*) n FROM demo_review_recovered_daily WHERE steam_app_id=?").get(t.steam_app_id) as any).n,
    retrievedReviewRecords:(db.prepare("SELECT COUNT(*) n FROM demo_review_backfill_items WHERE steam_app_id=?").get(t.steam_app_id) as any).n,
  }));
  console.log(JSON.stringify({apply,since,until,scope,plannedJobs:plan.length,result,jobs,coverage,observedAt:new Date().toISOString()}));
}finally{db.close();}
