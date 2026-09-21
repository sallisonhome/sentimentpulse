import type Database from "better-sqlite3";
import { metadataMatchesStorefront, uniquePlatformTitles } from "./console-title-identity";
import { DAILY_HISTORY_DAYS, DAILY_MIX_VERSION, median, proposeDailyMix, type DailyEvidence } from "./revenue-mix-daily-model";
import { MIX_PLATFORMS, type Mix } from "./revenue-mix-model";

type DB = Database.Database;
type Policy = { familyKey: (name: string) => string; protectedTitle: (name: string) => boolean; baseline: Mix; asp: Mix };
type Member = { titleId: number; platform: string; msrpUsdCents: number | null; name: string; released: string | null;
  gp: number; manual: number; overridden: number; anchored: number };
type Family = { key: string; members: Member[]; signature: string; blocked?: string; cohort: string };
const iso = (date: Date) => date.toISOString().slice(0,10);
const shift = (date: string, days: number) => iso(new Date(Date.parse(date+"T00:00:00Z")+days*86400000));
const age = (date: string, released: string | null) => released ? (Date.parse(date)-Date.parse(released.slice(0,10)))/86400000 : NaN;

export function ensureDailyMixSchema(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS revenue_mix_daily (
    family_key TEXT NOT NULL, date TEXT NOT NULL, version TEXT NOT NULL, signature TEXT NOT NULL,
    evidence_json TEXT NOT NULL, result_json TEXT NOT NULL, baseline_revenue_json TEXT NOT NULL,
    delta_json TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(family_key,date,version));
    CREATE INDEX IF NOT EXISTS revenue_mix_daily_date ON revenue_mix_daily(date,version);
    CREATE TABLE IF NOT EXISTS revenue_mix_daily_runs (
      date TEXT NOT NULL, version TEXT NOT NULL, completed_at TEXT NOT NULL, mode TEXT NOT NULL,
      families INTEGER NOT NULL, adjusted INTEGER NOT NULL, PRIMARY KEY(date,version));`);
}

export function dailyMixMode(db: DB): "active" | "shadow" | "off" {
  const setting = (key: string) => (db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as any)?.value;
  if (setting("revenue_mix_mode")==="off") return "off"; // preserve the original global kill switch
  const mode = setting("revenue_mix_daily_mode");
  return mode==="active" || mode==="shadow" ? mode : "off"; // missing/invalid configuration fails closed
}

function families(db: DB, policy: Policy, date: string): Family[] {
  const rows = db.prepare(`SELECT p.title_id titleId,p.platform,p.msrp_usd_cents msrpUsdCents,
    p.is_gamepass gp,p.is_manual_override manual,i.store_name storeName,i.name enrichedName,
    CASE WHEN p.platform='xbox' THEN x.name WHEN i.match_confidence='low' THEN i.store_name ELSE COALESCE(i.name,i.store_name) END name,
    i.store_release_date storeReleased,
    CASE WHEN i.match_confidence='low' THEN i.store_release_date ELSE COALESCE(i.release_date,i.store_release_date) END released,
    x.source cacheSource,
    EXISTS(SELECT 1 FROM title_multiplier_overrides o WHERE o.title_id=p.title_id AND o.effective_from<=?) overridden,
    EXISTS(SELECT 1 FROM revenue_calibration_anchors a WHERE a.title_id=p.title_id) anchored
    FROM platform_sku_map p LEFT JOIN console_title_igdb i ON i.title_id=p.title_id
    LEFT JOIN xbox_title_cache x ON p.platform='xbox' AND x.big_id=p.external_sku
    WHERE p.sku_role='base' AND p.business_model='paid' AND p.platform IN ('steam','ps5','xbox')`).all(date+"T23:59:59Z") as any[];
  // A protected regional mapping protects the whole signal even when a
  // differently priced region becomes its canonical metadata representative.
  const protectedIds = new Set(rows.filter(r=>r.gp||r.manual||r.overridden||r.anchored).map(r=>`${r.titleId}|${r.platform}`));
  const grouped = new Map<string, Member[]>();
  for (const r of uniquePlatformTitles(rows)) {
    if (!metadataMatchesStorefront(r.storeName,r.enrichedName) ||
      (r.platform==="xbox" && r.cacheSource==="seeded_from_cti" && !metadataMatchesStorefront(r.storeName,r.name))) {
      r.name=r.storeName; r.released=r.storeReleased;
    }
    const key = policy.familyKey(r.name??"");
    if (!key) continue;
    const list=grouped.get(key)??[]; list.push(r); grouped.set(key,list);
  }
  return Array.from(grouped.entries()).map(([key,members])=>{
    members.sort((a,b)=>a.platform.localeCompare(b.platform)||a.titleId-b.titleId);
    const steam = members.find(m=>m.platform==="steam");
    const ages = members.map(m=>age(date,m.released));
    let blocked: string | undefined;
    if (members.length!==3 || !MIX_PLATFORMS.every(p=>members.some(m=>m.platform===p))) blocked="ambiguous_or_incomplete_family";
    else if (members.some(m=>protectedIds.has(`${m.titleId}|${m.platform}`)||policy.protectedTitle(m.name))) blocked="protected_family";
    else if (members.some(m=>m.msrpUsdCents==null||m.msrpUsdCents<=0)) blocked="missing_price";
    else if (ages.some(a=>!Number.isFinite(a)||a<30) ||
      (Math.max(...ages)-Math.min(...ages)>7 && Math.min(...ages)<90)) blocked="young_unknown_or_staggered_release";
    return {key,members,blocked,cohort:`${age(date,steam?.released??null)<=180?"recent":"catalog"}:${(steam?.msrpUsdCents??0)>=4000?"premium":"budget"}`,
      signature:JSON.stringify({members:members.map(m=>[m.titleId,m.platform,m.msrpUsdCents,m.released]),baseline:policy.baseline,asp:policy.asp})};
  });
}

/** Called after collection, estimation AND actual-revenue anchors finish. */
export function runDailyMix(db: DB, policy: Policy, now = new Date()) {
  ensureDailyMixSchema(db);
  const mode=dailyMixMode(db), date=iso(now);
  if(mode==="off") return {mode,date,families:0,adjusted:0};
  const all=families(db,policy,date);
  const observations=db.prepare(`SELECT title_id id,platform,substr(capture_date,1,10) date,rating_count count
    FROM store_rating_signal_daily WHERE capture_date>=? AND capture_date<=?
    AND (window_label IS NULL OR window_label='ltd') AND rating_count IS NOT NULL ORDER BY capture_date`)
    .all(shift(date,-DAILY_HISTORY_DAYS-1),date+"T23:59:59.999Z") as any[];
  const histories=new Map<string,Map<string,number>>();
  for(const row of observations) {
    const key=`${row.id}|${row.platform}`, h=histories.get(key)??new Map();
    h.set(row.date,row.count);histories.set(key,h);
  }
  const evidence: DailyEvidence[]=all.map(f=>{
    const e:DailyEvidence={key:f.key,cohort:f.cohort,baseline:policy.baseline,today:[0,0,0],
      history:Array.from({length:DAILY_HISTORY_DAYS},()=>[0,0,0] as Mix),blocked:f.blocked};
    for(const [pi,p] of Array.from(MIX_PLATFORMS.entries())){
      const m=f.members.find(m=>m.platform===p);if(!m) continue;
      const h=histories.get(`${m.titleId}|${p}`)??new Map();
      const counts=Array.from({length:DAILY_HISTORY_DAYS+2},(_,i)=>h.get(shift(date,i-DAILY_HISTORY_DAYS-1)));
      if(counts.some(c=>c==null||!Number.isFinite(c))) {e.blocked??="missing_or_stale_daily_history";continue;}
      const deltas=counts.slice(1).map((c,i)=>c!-counts[i]!);
      if(deltas.some(n=>n<0)) {e.blocked??="rating_reset";continue;}
      e.today[pi]=deltas[DAILY_HISTORY_DAYS];
      for(let i=0;i<DAILY_HISTORY_DAYS;i++) e.history[i][pi]=deltas[i];
    }
    return e;
  });
  const insert=db.prepare(`INSERT INTO revenue_mix_daily VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(family_key,date,version) DO UPDATE SET signature=excluded.signature,evidence_json=excluded.evidence_json,
    result_json=excluded.result_json,baseline_revenue_json=excluded.baseline_revenue_json,
    delta_json=excluded.delta_json,applied=excluded.applied`);
  let adjusted=0;
  db.transaction(()=>{
    for(const [fi,f] of Array.from(all.entries())){
      const previous=db.prepare(`SELECT result_json FROM revenue_mix_daily WHERE family_key=? AND date=?
        AND version=? AND signature=? AND applied=1`).get(f.key,shift(date,-1),DAILY_MIX_VERSION,f.signature) as any;
      let result=proposeDailyMix(evidence[fi],evidence,previous?JSON.parse(previous.result_json).candidate:undefined);
      const steam=f.members.find(m=>m.platform==="steam");
      let dailySteam: number|null=null;
      if(!f.blocked && steam) {
        // Real adjacent daily LTD increments only. Never spread a 7-day total
        // uniformly over days or call a bootstrap/method reset a sale.
        const rows=db.prepare(`SELECT substr(as_of_date,1,10) date,units_mid units,method
          FROM window_estimates_daily WHERE title_id=? AND platform='steam' AND window='ltd'
          AND as_of_date>=? AND as_of_date<=? ORDER BY as_of_date`)
          .all(steam.titleId,shift(date,-15),date+"T23:59:59.999Z") as any[];
        const byDate=new Map<string,any>(rows.map(r=>[r.date,r]));
        const today=byDate.get(date), yesterday=byDate.get(shift(date,-1));
        const validPair=(a:any,b:any)=>a&&b&&Number.isFinite(a.units)&&Number.isFinite(b.units)
          && a.units>=b.units&&a.method===b.method&&typeof a.method==="string"&&a.method.includes("ltd_state:");
        if(validPair(today,yesterday)){
          const dailyUnits=today.units-yesterday.units;
          const past:number[]=[];
          for(let d=1;d<=14;d++){
            const a=byDate.get(shift(date,-d)),b=byDate.get(shift(date,-d-1));
            if(validPair(a,b)&&a.units>b.units) past.push(a.units-b.units);
          }
          if(past.length>=7 && dailyUnits<=20*median(past)) {
            dailySteam=dailyUnits*steam.msrpUsdCents!*policy.asp[0]/100;
          }
        }
      }
      if(dailySteam==null && result.reason==="daily_outlier") {
        result={...result,candidate:policy.baseline,confidence:0,reason:"unreliable_daily_revenue"};
      }
      const base=policy.baseline.map(n=>(dailySteam??0)*n/policy.baseline[0]) as Mix;
      const candidate=result.candidate.map(n=>(dailySteam??0)*n/result.candidate[0]) as Mix;
      const delta=candidate.map((n,i)=>Math.abs(n-base[i])<1e-8?0:n-base[i]) as Mix;
      delta[0]=0; // never modify the Steam revenue reference
      const applied=mode==="active"&&result.reason==="daily_outlier"&&dailySteam!=null&&dailySteam>0;
      if(applied) adjusted++;
      insert.run(f.key,date,DAILY_MIX_VERSION,f.signature,JSON.stringify(evidence[fi]),JSON.stringify(result),
        JSON.stringify(base),JSON.stringify(delta),Number(applied));
    }
    db.prepare(`INSERT INTO revenue_mix_daily_runs VALUES(?,?,?,?,?,?)
      ON CONFLICT(date,version) DO UPDATE SET completed_at=excluded.completed_at,mode=excluded.mode,
      families=excluded.families,adjusted=excluded.adjusted`)
      .run(date,DAILY_MIX_VERSION,now.toISOString(),mode,all.length,adjusted);
  })();
  return {mode,date,families:all.length,adjusted};
}

export function dailyMixStatus(db: DB, now=new Date()) {
  const mode=dailyMixMode(db);
  const run=db.prepare("SELECT * FROM revenue_mix_daily_runs WHERE version=? ORDER BY date DESC LIMIT 1").get(DAILY_MIX_VERSION) as any;
  const fresh=Boolean(run && Date.parse(run.completed_at)<=now.getTime() &&
    now.getTime()-Date.parse(run.completed_at)<=36*3600000 && run.date>=shift(iso(now),-1));
  return {mode,version:DAILY_MIX_VERSION,enabled:mode==="active",applied:mode==="active"&&fresh&&run?.mode==="active"&&run.adjusted>0,
    fresh,evaluationMode:run?.mode??null,lastEvaluation:run?.completed_at??null,families:run?.families??0,adjustedToday:fresh?run?.adjusted??0:0,
    note:mode==="active"
      ? `Daily adaptive revenue mix is enabled. Eligible title families receive small, evidence-based daily adjustments; normal or insufficient signals retain baseline estimates. Verified anchors remain protected. ${fresh&&run.mode==="active"?`${run.adjusted} ${run.adjusted===1?"family":"families"} adjusted in the latest daily evaluation.`:"Awaiting a fresh daily evaluation; baseline estimates are shown."}`
      : mode==="shadow" ? "Daily adaptive revenue mix is in shadow mode; proposals are recorded but published estimates use the baseline model."
      : "Daily adaptive revenue mix is off. Published estimates use the baseline model."};
}

export type DailyAdjustment = { delta: Mix; baseline: Mix; days: number };
function safeLedgerValues(row: any, policy: Policy) {
  try {
    const delta=JSON.parse(row.delta_json) as Mix,baseline=JSON.parse(row.baseline_revenue_json) as Mix;
    const result=JSON.parse(row.result_json);
    const candidate=result.candidate as Mix;
    if(!Array.isArray(delta)||delta.length!==3||!Array.isArray(baseline)||baseline.length!==3||
      !Array.isArray(candidate)||candidate.length!==3 || !delta.every(Number.isFinite) ||
      !baseline.every(n=>Number.isFinite(n)&&n>=0) ||
      !candidate.every((n,i)=>Number.isFinite(n)&&n>0&&Math.abs(n-policy.baseline[i])<=.050000001) ||
      Math.abs(candidate.reduce((a,b)=>a+b,0)-1)>1e-8 || Math.abs(delta[0])>1e-8) return null;
    for(let i=0;i<3;i++){
      const expectedBase=baseline[0]*policy.baseline[i]/policy.baseline[0];
      const expectedDelta=baseline[0]*candidate[i]/candidate[0]-baseline[i];
      if(Math.abs(baseline[i]-expectedBase)>.01 || Math.abs(delta[i]-expectedDelta)>.01) return null;
    }
    if(row.applied && result.reason!=="daily_outlier") return null;
    return {delta,baseline};
  } catch { return null; }
}
export function publishedDailyAdjustments(db: DB, policy: Policy, window: string, now=new Date()) {
  const output=new Map<string,DailyAdjustment>(), status=dailyMixStatus(db,now);
  if(status.mode!=="active"||!status.fresh||status.evaluationMode!=="active") return output;
  const days:Record<string,number>={d7:7,d30:30,d90:90,m12:365};
  if(window!=="ltd"&&!days[window]) return output;
  const date=iso(now), from=window==="ltd"?"0000-01-01":shift(date,-days[window]);
  const current=new Map(families(db,policy,date).filter(f=>!f.blocked).map(f=>[f.key,f.signature]));
  const rows=db.prepare(`SELECT * FROM revenue_mix_daily WHERE version=? AND date>? AND date<=? AND applied=1`)
    .all(DAILY_MIX_VERSION,from,date) as any[];
  for(const row of rows){
    if(current.get(row.family_key)!==row.signature) continue;
    const values=safeLedgerValues(row,policy);if(!values) continue;
    const {delta,baseline}=values;
    const prev=output.get(row.family_key)??{delta:[0,0,0],baseline:[0,0,0],days:0};
    prev.delta=prev.delta.map((n,i)=>n+delta[i]) as Mix;
    prev.baseline=prev.baseline.map((n,i)=>n+baseline[i]) as Mix;
    prev.days++;output.set(row.family_key,prev);
  }
  return output;
}

export function applyDailyAdjustment(revenue: number|null, adjustment: DailyAdjustment|undefined, platform: string) {
  const i=MIX_PLATFORMS.indexOf(platform as any);
  if(i<1||revenue==null||revenue<0||!adjustment) return {revenue,delta:0,days:0};
  // A ledger representing more baseline sales than this window contains is
  // incompatible with the current estimator revision. Do not invent an allocation.
  if(adjustment.baseline[i]>revenue+Math.max(1,revenue*.01)||revenue+adjustment.delta[i]<0) {
    return {revenue,delta:0,days:0};
  }
  return {revenue:revenue+adjustment.delta[i],delta:adjustment.delta[i],days:adjustment.days};
}

/** Recorded eligible daily baseline/applied revenue for the daily chart. */
export function publishedDailyRevenue(db: DB, policy: Policy, key: string, from: string, to: string, now=new Date()) {
  const output=new Map<string,Mix>(),status=dailyMixStatus(db,now);
  if(status.mode!=="active"||!status.fresh||status.evaluationMode!=="active") return output;
  const family=families(db,policy,iso(now)).find(f=>f.key===key&&!f.blocked);
  if(!family) return output;
  const rows=db.prepare(`SELECT date,baseline_revenue_json,delta_json,result_json,applied FROM revenue_mix_daily
    WHERE family_key=? AND signature=? AND version=? AND date>=? AND date<=? AND date<=?`)
    .all(key,family.signature,DAILY_MIX_VERSION,from,to,iso(now)) as any[];
  for(const r of rows){
    const values=safeLedgerValues(r,policy);if(!values) continue;
    const {baseline:base,delta}=values;
    if(base[0]<=0 || !base.every(n=>Number.isFinite(n)&&n>=0)) continue;
    const revenue=base.map((n,i)=>n+(r.applied?delta[i]:0)) as Mix;
    if(revenue.every(n=>Number.isFinite(n)&&n>=0)) output.set(r.date,revenue);
  }
  return output;
}
