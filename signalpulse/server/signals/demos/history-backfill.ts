import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {allHistoryReportUrl,parseDatedDownloadReport} from "./download-report";

export interface HistoryTitle {steam_app_id:string;name:string;is_saber_published:number;release_date:string|null}
type Job={steam_app_id:string;kind:"downloads"|"reviews";start_date:string;end_date:string;next_date:string|null;
  cursor:string;status:string;pages:number;expected_reviews:number|null;started_at:string;updated_at:string;error:string|null};
const DAY=86400000;
export const dateOffset=(day:string,n:number)=>new Date(Date.parse(`${day}T00:00:00Z`)+n*DAY).toISOString().slice(0,10);
export function validDay(day:string){
  return /^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
}
const stamp=()=>new Date().toISOString();
export const completedReportDay=()=>dateOffset(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),-1);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/** Shared request/time ceiling. No unbounded retries, parallel floods, or raw
 * provider errors (which can contain credentials) in persisted diagnostics. */
export class HistoryBudget {
  requests=0;readonly started=Date.now();
  stopped=false;
  constructor(readonly maxRequests=200,readonly maxMs=240000,readonly delayMs=750,readonly transport:typeof fetch=fetch){}
  get available(){return !this.stopped&&this.requests<this.maxRequests&&Date.now()-this.started<this.maxMs;}
  async get(url:string,cookie?:string){
    if(!this.available)throw Error("History request budget reached");
    if(this.requests)await sleep(this.delayMs);
    if(!this.available)throw Error("History request budget reached");
    this.requests++;
    const r=await this.transport(url,{redirect:"manual",signal:AbortSignal.timeout(Math.min(20000,Math.max(1,this.maxMs-(Date.now()-this.started)))),
      headers:{"User-Agent":"SignalPulse/1.0","Accept-Language":"en-US",...(cookie?{Cookie:cookie}:{})}});
    if([401,403,429].includes(r.status))this.stopped=true;
    if(r.status!==200)throw Error(`History source HTTP ${r.status}`);
    return r;
  }
}
function sourceCheck(db:Database.Database,id:string,source:string,ok:boolean){
  const now=stamp();
  db.prepare(`INSERT INTO demo_history_source_checks VALUES(?,?,?,?,?)
    ON CONFLICT(steam_app_id,source) DO UPDATE SET attempted_at=excluded.attempted_at,
    succeeded_at=COALESCE(excluded.succeeded_at,demo_history_source_checks.succeeded_at),error=excluded.error`)
    .run(id,source,now,ok?now:null,ok?null:"Source unavailable or validation failed; retained last good history");
}
async function reportScope(title:HistoryTitle,cookie:string,budget:HistoryBudget){
  if(!/^[1-9]\d{0,9}$/.test(title.steam_app_id))throw Error("Invalid demo identity");
  if(!cookie)throw Error("Steamworks session unavailable");
  const html=await(await budget.get(`https://partner.steampowered.com/nav_regions.php?downloads=1&appID=${title.steam_app_id}`,cookie)).text();
  return new URL(allHistoryReportUrl(html,title.steam_app_id,title.name));
}
async function collectDate(db:Database.Database,title:HistoryTitle,date:string,scope:URL,cookie:string,budget:HistoryBudget){
  // Both explicit reports required to advance a date. Successful first reads
  // are still retained if the second fails; retries are idempotent.
  let written=0;
  for(const kind of ["day","to_date"] as const){
    const url=new URL(scope),start=kind==="day"?date:"2000-01-01";
    url.searchParams.set("dateStart",start);url.searchParams.set("dateEnd",date);
    const html=await(await budget.get(url.href,cookie)).text();
    // Checks current source's exact App ID link as well as report title,
    // metric definition, both requested dates and one unambiguous total.
    allHistoryReportUrl(html,title.steam_app_id,title.name);
    const downloads=parseDatedDownloadReport(html,title.name,start,date),fetchedAt=stamp();
    db.prepare(`INSERT INTO demo_download_dated_reports VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(steam_app_id,report_date,scope) DO UPDATE SET downloads=excluded.downloads,
      report_start_date=excluded.report_start_date,fetched_at=excluded.fetched_at,source_url=excluded.source_url
      WHERE excluded.fetched_at>=demo_download_dated_reports.fetched_at`)
      .run(title.steam_app_id,date,kind,downloads,start,fetchedAt,url.href);
    written++;
  }
  sourceCheck(db,title.steam_app_id,"steamworks_dated_reports",true);
  return written;
}

/** Called inside the existing daily demo pipeline. Fetch the last three
 * completed report dates to tolerate late revisions; never create past
 * observation-date rows or touch the latest actuals/paid-sales tables. */
export async function refreshRecentDemoReports(db:Database.Database,titles:HistoryTitle[],approved:ReadonlySet<string>,
  cookie:string|undefined,budget=new HistoryBudget(48,120000),today=stamp().slice(0,10)){
  const result={attempted:0,succeeded:0,failed:0,rowsWritten:0,requests:0,budgetLimited:false};
  for(const title of titles.filter(t=>t.is_saber_published===1&&approved.has(t.steam_app_id))){
    if(!budget.available){result.budgetLimited=true;break;}
    result.attempted++;
    try{
      const scope=await reportScope(title,cookie??"",budget);
      const last=[dateOffset(today,-1),completedReportDay(),scope.searchParams.get("dateEnd")!].sort()[0];
      for(let i=0;i<3;i++){
        const date=dateOffset(last,-i);
        result.rowsWritten+=await collectDate(db,title,date,scope,cookie!,budget);
      }
      result.succeeded++;
    }catch{
      result.failed++;sourceCheck(db,title.steam_app_id,"steamworks_dated_reports",false);
      if(!budget.available)result.budgetLimited=true;
    }
  }
  result.requests=budget.requests;return result;
}

/** Explicit operator-selected date scope. No task is enrolled implicitly by
 * reading a PDP or starting the server. Existing cursors are never reset. */
export function planHistoryBackfill(db:Database.Database,titles:HistoryTitle[],approved:ReadonlySet<string>,
  since:string,until:string,scope:"all"|"saber"|"reviews"="all",apply=false){
  if(!validDay(since)||!validDay(until)||since<"2000-01-01"||since>until||until>completedReportDay())
    throw Error("Backfill needs a valid, completed date range");
  const plan=titles.flatMap(t=>{
    const jobs:Array<{appId:string;name:string;kind:"downloads"|"reviews";start:string;end:string}>=[];
    if(scope!=="reviews"&&t.is_saber_published===1&&approved.has(t.steam_app_id))
      jobs.push({appId:t.steam_app_id,name:t.name,kind:"downloads",start:since,end:until});
    if(scope!=="saber")jobs.push({appId:t.steam_app_id,name:t.name,kind:"reviews",start:since,end:until});
    return jobs;
  });
  if(apply)db.transaction(()=>{
    const insert=db.prepare(`INSERT OR IGNORE INTO demo_history_backfill_jobs
      (steam_app_id,kind,start_date,end_date,next_date,started_at,updated_at) VALUES(?,?,?,?,?,?,?)`);
    for(const p of plan){
      const existing=db.prepare("SELECT start_date,end_date FROM demo_history_backfill_jobs WHERE steam_app_id=? AND kind=?")
        .get(p.appId,p.kind) as any;
      if(existing&&(existing.start_date!==since||existing.end_date!==until))throw Error("Existing backfill has a different date scope; do not reset checkpoints implicitly");
      insert.run(p.appId,p.kind,p.start,p.end,p.end,stamp(),stamp());
    }
  })();
  return plan;
}

function reviewsUrl(id:string,cursor:string){
  if(!/^[1-9]\d{0,9}$/.test(id))throw Error("Invalid demo identity");
  const url=new URL(`https://store.steampowered.com/appreviews/${id}`);
  url.search=new URLSearchParams({json:"1",filter:"recent",language:"all",review_type:"all",
    purchase_type:"all",filter_offtopic_activity:"0",num_per_page:"100",cursor}).toString();return url.href;
}
async function reviewPage(id:string,cursor:string,budget:HistoryBudget){
  const data=await(await budget.get(reviewsUrl(id,cursor))).json() as any;
  if(data.success!==1||!Array.isArray(data.reviews))throw Error("Review contract unavailable");
  return data;
}
function completeReviews(db:Database.Database,job:Job,total:number){
  const items=db.prepare("SELECT COUNT(*) n FROM demo_review_backfill_items WHERE steam_app_id=?").get(job.steam_app_id) as {n:number};
  const prior=db.prepare(`SELECT MAX(review_count_total) n FROM demo_window_estimates_daily e
    JOIN demo_titles t ON t.id=e.demo_title_id WHERE t.steam_app_id=? AND e.window='ltd'`).get(job.steam_app_id) as {n:number|null};
  // A retired endpoint returning an empty catalogue cannot erase positive
  // retained history. Pagination exhaustion alone is not completeness.
  let mismatch=items.n!==total||(total===0&&(prior?.n??0)>0);
  const daily=db.prepare(`SELECT activity_date,SUM(positive) positive,COUNT(*)-SUM(positive) negative
    FROM demo_review_backfill_items WHERE steam_app_id=? GROUP BY activity_date`).all(job.steam_app_id) as any[];
  const recovered=new Map(daily.map(d=>[d.activity_date,d]));
  const today=stamp().slice(0,10),recentCutoff=dateOffset(today,-7);
  // Reconcile recent completed days only when the histogram itself is fresh.
  // Never overwrite the higher-priority Valve histogram, even on agreement.
  const recent=db.prepare(`SELECT date(bucket_start,'unixepoch') day,recommendations_up,recommendations_down
    FROM steam_review_history WHERE app_id=? AND bucket_granularity='day'
    AND date(bucket_start,'unixepoch')>=? AND date(bucket_start,'unixepoch')<?
    AND substr(created_at,1,10)>=?`).all(job.steam_app_id,recentCutoff,today,dateOffset(today,-1)) as any[];
  for(const b of recent){
    const d=recovered.get(b.day);
    if((d?.positive??0)!==b.recommendations_up||(d?.negative??0)!==b.recommendations_down)mismatch=true;
  }
  db.transaction(()=>{
    if(!mismatch){
      const insert=db.prepare(`INSERT INTO demo_review_recovered_daily VALUES(?,?,?,?,?,?)
        ON CONFLICT(steam_app_id,activity_date) DO UPDATE SET positive=excluded.positive,
        negative=excluded.negative,fetched_at=excluded.fetched_at,source=excluded.source`);
      for(const d of daily)if(d.activity_date>=job.start_date&&d.activity_date<=job.end_date)
        insert.run(job.steam_app_id,d.activity_date,d.positive,d.negative,stamp(),"steam:appreviews:created-date");
    }
    db.prepare(`UPDATE demo_history_backfill_jobs SET status=?,updated_at=?,error=? WHERE steam_app_id=? AND kind='reviews'`)
      .run(mismatch?"mismatch":"complete",stamp(),mismatch?"Review pagination, summary or fresh histogram counts disagree; recovered estimates withheld":null,job.steam_app_id);
    if(!mismatch)sourceCheck(db,job.steam_app_id,"review_history_recovery",true);
  })();
}

/** Resumable, serial, bounded one-time operator run. The allow-list is rebuilt
 * from the current eligible catalog on every invocation. No raw review text,
 * author IDs or Steamworks content/credentials are retained. */
export async function runHistoryBackfill(db:Database.Database,titles:HistoryTitle[],approved:ReadonlySet<string>,
  cookie:string|undefined,budget=new HistoryBudget(),scope:"all"|"saber"|"reviews"="all"){
  const roster=new Map(titles.map(t=>[t.steam_app_id,t]));
  const jobs=db.prepare(`SELECT * FROM demo_history_backfill_jobs WHERE status IN ('pending','running','error')
    ORDER BY CASE kind WHEN 'downloads' THEN 0 ELSE 1 END,updated_at,steam_app_id`).all() as Job[];
  const result={jobsAttempted:0,requests:0,budgetLimited:false,errors:0,stopReason:null as string|null};
  for(const job of jobs){
    const title=roster.get(job.steam_app_id);
    if(!title||(scope==="saber"&&job.kind!=="downloads")||(scope==="reviews"&&job.kind!=="reviews"))continue;
    if(job.kind==="downloads"&&(title.is_saber_published!==1||!approved.has(job.steam_app_id)))continue;
    if(!budget.available){result.budgetLimited=true;break;}
    result.jobsAttempted++;
    try{
      if(job.kind==="downloads"){
        const report=await reportScope(title,cookie??"",budget);
        // A provider clamping the date is not an empty successful history.
        if(job.end_date>report.searchParams.get("dateEnd")!)throw Error("Report end not available");
        // Ten dates per title per invocation so a long-lived demo cannot
        // permanently starve every other title.
        for(let n=0;n<10&&job.next_date&&job.next_date>=job.start_date;n++){
          if(!budget.available)break;
          const date=job.next_date;
          const existing=db.prepare("SELECT COUNT(*) n FROM demo_download_dated_reports WHERE steam_app_id=? AND report_date=?")
            .get(job.steam_app_id,date) as {n:number};
          if(existing.n!==2)await collectDate(db,title,date,report,cookie!,budget);
          job.next_date=dateOffset(date,-1);
          db.prepare(`UPDATE demo_history_backfill_jobs SET next_date=?,status=?,updated_at=?,error=NULL
            WHERE steam_app_id=? AND kind='downloads'`).run(job.next_date,job.next_date<job.start_date?"complete":"running",stamp(),job.steam_app_id);
        }
      }else{
        for(let n=0;n<10&&budget.available;n++){
          const data=await reviewPage(job.steam_app_id,job.cursor,budget);
          const expected=data.query_summary?.total_reviews;
          if(job.pages===0&&(!Number.isSafeInteger(expected)||expected<0))throw Error("Review summary unavailable");
          if(!data.reviews.length){
            // Check current summary rather than assuming a cursor from a
            // previous invocation still represents an unchanged catalog.
            const current=await reviewPage(job.steam_app_id,"*",budget);
            const total=current.query_summary?.total_reviews;
            if(!Number.isSafeInteger(total)||total<0)throw Error("Review summary unavailable");
            completeReviews(db,job,total);break;
          }
          if(typeof data.cursor!=="string"||!data.cursor||data.cursor===job.cursor)throw Error("Review cursor stalled");
          const rows=data.reviews.map((r:any)=>{
            if(!/^\d+$/.test(String(r.recommendationid))||!Number.isSafeInteger(r.timestamp_created)||
              r.timestamp_created<Date.parse("2000-01-01")/1000||r.timestamp_created>Date.now()/1000+300||typeof r.voted_up!=="boolean")
              throw Error("Invalid review identity or date");
            return [job.steam_app_id,createHash("sha256").update(String(r.recommendationid)).digest("hex"),
              new Date(r.timestamp_created*1000).toISOString().slice(0,10),r.voted_up?1:0];
          });
          db.transaction(()=>{
            const insert=db.prepare("INSERT OR IGNORE INTO demo_review_backfill_items VALUES(?,?,?,?)");
            let added=0;for(const row of rows)added+=insert.run(...row).changes;
            if(!added)throw Error("Review cursor returned no new identities");
            db.prepare(`UPDATE demo_history_backfill_jobs SET cursor=?,pages=pages+1,
              expected_reviews=COALESCE(expected_reviews,?),status='running',updated_at=?,error=NULL
              WHERE steam_app_id=? AND kind='reviews'`).run(data.cursor,expected??null,stamp(),job.steam_app_id);
          })();
          job.cursor=data.cursor;job.pages++;
        }
      }
    }catch{
      if(!budget.available&&!budget.stopped){result.budgetLimited=true;break;}
      result.errors++;
      db.prepare(`UPDATE demo_history_backfill_jobs SET status='error',updated_at=?,error=?
        WHERE steam_app_id=? AND kind=?`).run(stamp(),"Source unavailable or validation failed; checkpoint retained",job.steam_app_id,job.kind);
      sourceCheck(db,job.steam_app_id,job.kind==="downloads"?"steamworks_dated_reports":"review_history_recovery",false);
      if(budget.stopped){result.stopReason="Source authentication or rate-limit response; stopped without retrying";break;}
    }
  }
  result.requests=budget.requests;result.budgetLimited ||= !budget.available&&!budget.stopped;return result;
}
