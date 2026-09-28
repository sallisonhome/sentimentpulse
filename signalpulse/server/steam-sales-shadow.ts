import type Database from "better-sqlite3";
import {activeMilestones,validateMilestone,milestoneCanOverlay} from "./steam-unit-calibration";
import {reviewShockEvidence} from "./steam-review-shocks";

export const STEAM_SALES_SHADOW_VERSION="steam_ccu_sales_shadow_v1";
export const STEAM_CCU_URL="https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/";
const DAY=86400000;
function enabled(db:Database.Database){
  if(process.env.STEAM_SALES_SHADOW_ENABLED==="0")return false;
  // Durable kill switch also works in systemd's separately launched daily processes.
  const table=db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_settings'").get();
  return !table||(db.prepare("SELECT value FROM app_settings WHERE key='steam_sales_shadow_enabled'").get() as any)?.value!=="0";
}
const median=(xs:number[])=>{
  const a=[...xs].sort((x,y)=>x-y),n=a.length;
  return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;
};
export function initSteamSalesShadow(db:Database.Database){
  db.exec(`CREATE TABLE IF NOT EXISTS steam_sales_ccu_samples(
    app_id TEXT NOT NULL,date TEXT NOT NULL,ccu INTEGER NOT NULL,rank INTEGER NOT NULL,
    captured_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(app_id,date));
    CREATE TABLE IF NOT EXISTS steam_sales_shadow_daily(
    app_id TEXT NOT NULL,date TEXT NOT NULL,version TEXT NOT NULL,evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(app_id,date,version));
    CREATE TABLE IF NOT EXISTS steam_sales_shadow_collection(
    date TEXT PRIMARY KEY,status TEXT NOT NULL,detail TEXT NOT NULL,updated_at TEXT NOT NULL);`);
}
/** One bounded public read; never retries/races other Steam collectors or changes their cooldown. */
export async function collectSteamSalesCcu(db:Database.Database,fetcher:typeof fetch=fetch,now=new Date()){
  const date=now.toISOString().slice(0,10);
  if(!enabled(db))return {status:"disabled",count:0};
  const prior=db.prepare("SELECT status FROM steam_sales_shadow_collection WHERE date=?").get(date) as any;
  if(prior?.status==="complete")return {status:"already_observed",count:0};
  const cooldown=db.prepare("SELECT detail FROM steam_sales_shadow_collection WHERE status='cooldown' ORDER BY updated_at DESC LIMIT 1").get() as any;
  if(cooldown){
    try {if(JSON.parse(cooldown.detail).retryAt>now.getTime())return {status:"cooldown",count:0};}
    catch {return {status:"cooldown_invalid",count:0};}
  }
  try{
    const response=await fetcher(STEAM_CCU_URL,{signal:AbortSignal.timeout(12000)});
    if(response.status===429){
      const h=response.headers.get("retry-after");
      const seconds=h&&/^\d+$/.test(h)?Number(h):null;
      const retryAt=seconds!=null?now.getTime()+seconds*1000:h?Date.parse(h):NaN;
      db.prepare(`INSERT INTO steam_sales_shadow_collection VALUES(?,'cooldown',?,?)
        ON CONFLICT(date) DO UPDATE SET status=excluded.status,detail=excluded.detail,updated_at=excluded.updated_at`)
        .run(date,JSON.stringify({retryAt:Number.isFinite(retryAt)?retryAt:now.getTime()+DAY}),now.toISOString());
      return {status:"cooldown",count:0};
    }
    if(!response.ok)throw Error(`Steam CCU HTTP ${response.status}; no retry this invocation`);
    const body:any=await response.json(),rows=body?.response?.ranks;
    if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw Error("invalid Steam CCU envelope");
    const seen=new Set<number>();
    for(const r of rows){
      if(!Number.isSafeInteger(r.appid)||r.appid<=0||seen.has(r.appid)||
        !Number.isSafeInteger(r.concurrent_in_game)||r.concurrent_in_game<0||
        !Number.isSafeInteger(r.rank)||r.rank<=0)throw Error("invalid or duplicate Steam CCU row");
      seen.add(r.appid);
    }
    db.transaction(()=>{
      const put=db.prepare("INSERT INTO steam_sales_ccu_samples VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING");
      for(const r of rows)put.run(String(r.appid),date,r.concurrent_in_game,r.rank,now.toISOString(),STEAM_CCU_URL);
      db.prepare(`INSERT INTO steam_sales_shadow_collection VALUES(?,'complete',?,?)
        ON CONFLICT(date) DO UPDATE SET status=excluded.status,detail=excluded.detail,updated_at=excluded.updated_at`)
        .run(date,JSON.stringify({observed:rows.length,scope:"Steam current CCU top chart; absent titles unknown"}),now.toISOString());
    })();
    return {status:"complete",count:rows.length};
  }catch(error){
    const detail=String(error);
    db.prepare(`INSERT INTO steam_sales_shadow_collection VALUES(?,'unavailable',?,?)
      ON CONFLICT(date) DO UPDATE SET status=excluded.status,detail=excluded.detail,updated_at=excluded.updated_at`)
      .run(date,detail,now.toISOString());
    return {status:"unavailable",count:0,detail};
  }
}
type ShadowDay={date:string;ccu:number;reviews:number;minuteUtc:number};
export function proposeSteamSalesAdjustment(input:{days:ShadowDay[];endDate:string;baseline:number|null;
  shock:boolean;protectedTitle:boolean;anchorCoefficient:number|null}){
  const no=(reason:string)=>({mode:"shadow",applied:false,reason,proposedFactor:1,
    proposedMultiplier:input.baseline,requiresIndependentValidation:true});
  if(input.shock)return no("review_activity_shock");
  if(input.protectedTitle)return no("protected_actual_or_manual_override");
  if(!(input.baseline!=null&&input.baseline>0&&Number.isFinite(input.baseline)))return no("missing_baseline");
  const end=Date.parse(input.endDate+"T00:00:00Z");
  const days=input.days.filter(r=>Date.parse(r.date+"T00:00:00Z")<=end&&
    Date.parse(r.date+"T00:00:00Z")>end-14*DAY).sort((a,b)=>a.date.localeCompare(b.date));
  if(days.length!==14||new Set(days.map(d=>d.date)).size!==14||
    days.some((d,i)=>Date.parse(d.date+"T00:00:00Z")!==end-(13-i)*DAY||
      !Number.isFinite(d.ccu)||d.ccu<0||!Number.isFinite(d.reviews)||d.reviews<0))
    return no("insufficient_14_day_paired_coverage");
  const minutes=days.map(d=>d.minuteUtc);
  if(Math.max(...minutes)-Math.min(...minutes)>90)return no("inconsistent_utc_sample_time");
  const before=days.slice(0,7),after=days.slice(7);
  const ccu0=median(before.map(d=>d.ccu)),ccu1=median(after.map(d=>d.ccu));
  const r0=before.reduce((s,d)=>s+d.reviews,0),r1=after.reduce((s,d)=>s+d.reviews,0);
  if(ccu0<=0||r0<100||r1<100)return no("insufficient_signal");
  const ccuRatio=ccu1/ccu0,reviewRatio=r1/r0;
  // Week-to-week blocks contain identical weekdays. This is a hypothesis,
  // not a learned coefficient or a claim that engagement is new purchases.
  const discrepancy=ccuRatio/reviewRatio;
  const sustained=after.filter(d=>d.ccu>=ccu0*.8).length>=5;
  const factor=sustained&&discrepancy>1.25?Math.min(1.10,1+(discrepancy-1)*.10):1;
  return {...no(factor===1?"within_norms":"sustained_ccu_review_divergence"),
    proposedFactor:factor,proposedMultiplier:input.baseline*factor,ccuRatio,reviewRatio,
    anchorCoefficient:input.anchorCoefficient,
    caveat:"CCU measures activity, not buyers. Retention, updates and free-access events can explain divergence. No automatic promotion."};
}
export function evaluateSteamSalesShadow(db:Database.Database,asOfDate:string){
  if(!enabled(db))return {mode:"disabled",evaluated:0};
  // Use completed UTC review days only, paired with that day's observed CCU.
  const endDate=new Date(Date.parse(asOfDate+"T00:00:00Z")-DAY).toISOString().slice(0,10);
  const titles=db.prepare(`SELECT p.external_sku AS appId,MIN(p.title_id) AS titleId,
    COALESCE(i.store_release_date,i.release_date) AS releaseDate
    FROM platform_sku_map p LEFT JOIN console_title_igdb i ON i.title_id=p.title_id
    WHERE p.platform='steam' AND p.sku_role='base' AND p.business_model='paid'
    GROUP BY p.external_sku HAVING COUNT(DISTINCT p.title_id)=1`).all() as any[];
  const milestones=new Map(activeMilestones(db).map(m=>[m.appId,m]));
  const write=db.prepare(`INSERT INTO steam_sales_shadow_daily VALUES(?,?,?,?,?)
    ON CONFLICT(app_id,date,version) DO UPDATE SET evidence_json=excluded.evidence_json,created_at=excluded.created_at`);
  const reasons:Record<string,number>={};
  db.transaction(()=>{
    for(const t of titles){
      const latest=db.prepare(`SELECT multiplier,digital_unit_share FROM title_multiplier_overrides
        WHERE title_id=? AND platform='steam' AND effective_from<=? ORDER BY effective_from DESC LIMIT 1`)
        .get(t.titleId,asOfDate+"T23:59:59Z") as any;
      const base=latest??db.prepare(`SELECT multiplier,digital_unit_share FROM ownership_multipliers
        WHERE platform='steam' AND cohort_key='default' AND effective_from<=?
        ORDER BY effective_from DESC LIMIT 1`).get(asOfDate+"T23:59:59Z") as any;
      const candidate=milestones.get(t.appId);
      const m=candidate&&milestoneCanOverlay(db,candidate,"ltd")?candidate:undefined;
      const baseline=m?validateMilestone(m).coefficient:
        base?.digital_unit_share>0?base.multiplier/base.digital_unit_share:null;
      const hist=db.prepare("SELECT * FROM steam_review_history WHERE app_id=?").all(t.appId) as any[];
      const shock=reviewShockEvidence(hist,endDate,t.releaseDate);
      const dayMap=new Map(hist.filter(r=>r.bucket_granularity==="day")
        .map(r=>[new Date(r.bucket_start*1000).toISOString().slice(0,10),r.recommendations_up+r.recommendations_down]));
      const samples=db.prepare(`SELECT * FROM steam_sales_ccu_samples WHERE app_id=?
        AND date<=? AND date>date(?,'-14 days') ORDER BY date`).all(t.appId,endDate,endDate) as any[];
      const days=samples.filter(r=>dayMap.has(r.date)).map(r=>({date:r.date,ccu:r.ccu,reviews:Number(dayMap.get(r.date)),
        minuteUtc:new Date(r.captured_at).getUTCHours()*60+new Date(r.captured_at).getUTCMinutes()}));
      const actual=!!db.prepare(`SELECT 1 FROM revenue_calibration_anchors WHERE title_id=? AND platform='steam'
        AND (data_source LIKE 'portal_fetch%' OR data_source LIKE 'manual_anchor_verified_%') LIMIT 1`).get(t.titleId);
      const shockStart=new Date(Date.parse(endDate+"T00:00:00Z")-13*DAY).toISOString().slice(0,10);
      const result=proposeSteamSalesAdjustment({days,endDate,baseline,shock:shock.invalid||shock.events.some(e=>e.date>=shockStart)||false,
        protectedTitle:actual||Boolean(latest&&!m),anchorCoefficient:m?validateMilestone(m).coefficient:null});
      write.run(t.appId,asOfDate,STEAM_SALES_SHADOW_VERSION,JSON.stringify({...result,
        evidenceThrough:endDate,pairedDays:days,baseline,milestoneId:m?.id??null,
        coverage:"Current Steam CCU chart only; missing titles/days remain unavailable",
        validation:"No held-out independent milestone validation yet"}),new Date().toISOString());
      reasons[result.reason]=(reasons[result.reason]??0)+1;
    }
  })();
  return {mode:"shadow",applied:false,evaluated:titles.length,reasons};
}
