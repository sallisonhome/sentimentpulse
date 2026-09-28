import type Database from "better-sqlite3";
import {reviewShockEvidence} from "./steam-review-shocks";

export const STEAM_UNIT_CALIBRATION_VERSION = "steam_public_unit_milestone_v1";
const DAY = 86400000;
const windows: Record<string, number | null> = {d7:7,d30:30,d90:90,m12:365,ltd:null};
export type Weight = {date:string; signal:number};
export type Milestone = {
  id:string; appId:string; titleId:number; startDate:string; asOfDate:string;
  units:number; sourceUrl:string; sourceQuote:string; weights:Weight[];
  supersededAnchor:{id:number; date:string; source:string; revenue:number; units:number};
  supersededOverride:{effectiveFrom:string; multiplier:number; method:string};
};
const dateMs = (s:string) => {
  const n=Date.parse(s+"T00:00:00Z");
  if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)throw Error("invalid date");
  return n;
};
export function validateMilestone(m:Milestone) {
  if(!/^\d+$/.test(m.appId)||!Number.isSafeInteger(m.titleId)||m.titleId<=0||
     !Number.isSafeInteger(m.units)||m.units<=0||!m.sourceUrl.startsWith("https://")||!m.sourceQuote)
    throw Error("invalid milestone identity/evidence");
  const start=dateMs(m.startDate),end=dateMs(m.asOfDate);
  if(end<start||end-start>366*DAY)throw Error("unsupported milestone span");
  const weights=[...m.weights].sort((a,b)=>a.date.localeCompare(b.date));
  if(weights.length!==(end-start)/DAY+1)throw Error("incomplete daily pattern");
  weights.forEach((w,i)=>{
    if(dateMs(w.date)!==start+i*DAY||!Number.isSafeInteger(w.signal)||w.signal<0)
      throw Error("invalid or duplicate daily weight");
  });
  const total=weights.reduce((s,w)=>s+w.signal,0);
  if(total<=0)throw Error("empty milestone signal");
  return {weights,total,coefficient:m.units/total};
}
/** Largest-remainder allocation: exact disclosed total, same modeled shape. */
export function allocateMilestone(m:Milestone) {
  const {weights,total}=validateMilestone(m);
  const rows=weights.map(w=>({...w,units:Math.floor(w.signal*m.units/total),
    remainder:(w.signal*m.units/total)%1}));
  let left=m.units-rows.reduce((s,w)=>s+w.units,0);
  for(const w of [...rows].sort((a,b)=>b.remainder-a.remainder||a.date.localeCompare(b.date)))
    if(left-->0)w.units++;
  return rows.map(({remainder,...w})=>w);
}
export function initSteamUnitCalibration(db:Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS steam_unit_milestones (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL, title_id INTEGER NOT NULL,
    as_of_date TEXT NOT NULL, payload_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS steam_unit_milestones_active
      ON steam_unit_milestones(app_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS steam_unit_calibration_daily (
      milestone_id TEXT NOT NULL REFERENCES steam_unit_milestones(id),
      date TEXT NOT NULL, signal REAL NOT NULL, units INTEGER NOT NULL,
      basis TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY(milestone_id,date));`);
}
export function activeMilestones(db:Database.Database):Milestone[] {
  if(process.env.STEAM_UNIT_CALIBRATION_ENABLED==="0")return [];
  return (db.prepare("SELECT payload_json FROM steam_unit_milestones WHERE active=1 ORDER BY id")
    .all() as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json));
}
export function validateMilestoneIdentity(db:Database.Database,m:Milestone) {
  validateMilestone(m);
  const skus=db.prepare(`SELECT DISTINCT title_id,external_sku FROM platform_sku_map
    WHERE platform='steam' AND sku_role='base' AND business_model='paid'
    AND (title_id=? OR external_sku=?)`).all(m.titleId,m.appId) as any[];
  if(skus.length!==1||skus[0].title_id!==m.titleId||skus[0].external_sku!==m.appId)
    throw Error("milestone App ID/title identity conflict");
}
export function installMilestone(db:Database.Database,m:Milestone,now=new Date().toISOString()) {
  validateMilestoneIdentity(db,m);
  const prior=db.prepare("SELECT payload_json FROM steam_unit_milestones WHERE id=?").get(m.id) as any;
  if(prior&&prior.payload_json!==JSON.stringify(m))throw Error("immutable milestone differs");
  const a=db.prepare("SELECT * FROM revenue_calibration_anchors WHERE id=?").get(m.supersededAnchor.id) as any;
  if(!a||a.title_id!==m.titleId||a.platform!=="steam"||a.window!=="ltd"||
    a.as_of_date!==m.supersededAnchor.date||a.data_source!==m.supersededAnchor.source||
    a.actual_units!==m.supersededAnchor.units||a.actual_revenue_usd!==m.supersededAnchor.revenue)
    throw Error("superseded anchor no longer matches audited before-image");
  db.transaction(()=>{
    db.prepare(`INSERT INTO steam_unit_milestones VALUES(?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET active=1`).run(m.id,m.appId,m.titleId,m.asOfDate,JSON.stringify(m),now);
    const insert=db.prepare(`INSERT INTO steam_unit_calibration_daily VALUES(?,?,?,?,?,?)
      ON CONFLICT(milestone_id,date) DO NOTHING`);
    for(const w of allocateMilestone(m))insert.run(m.id,w.date,w.signal,w.units,"modeled_milestone_allocation",now);
  })();
}
/** No source-table writes. A day is replaced by a high water, never added twice. */
export function refreshSteamUnitCalibration(db:Database.Database,asOfDate:string) {
  dateMs(asOfDate);
  let written=0;
  for(const m of activeMilestones(db)){
    validateMilestoneIdentity(db,m);
    const {coefficient}=validateMilestone(m);
    const raw=db.prepare("SELECT * FROM steam_review_history WHERE app_id=?").all(m.appId) as any[];
    const evidence=reviewShockEvidence(raw,asOfDate,m.startDate);
    if(evidence.invalid)continue;
    const daily=evidence.adjustedBuckets.filter(r=>r.bucket_granularity==="day")
      .map(r=>({date:new Date(r.bucket_start*1000).toISOString().slice(0,10),
        signal:r.recommendations_up+r.recommendations_down,observed:r.created_at??""}))
      .filter(r=>r.date>m.asOfDate&&r.date<=asOfDate&&Number.isSafeInteger(r.signal)&&r.signal>=0);
    const upsert=db.prepare(`INSERT INTO steam_unit_calibration_daily VALUES(?,?,?,?,?,?)
      ON CONFLICT(milestone_id,date) DO UPDATE SET
      signal=MAX(signal,excluded.signal), units=MAX(units,excluded.units),
      observed_at=CASE WHEN excluded.signal>=signal THEN excluded.observed_at ELSE observed_at END`);
    db.transaction(()=>{
      for(const r of daily){
        upsert.run(m.id,r.date,r.signal,Math.round(r.signal*coefficient),
          "modeled_review_growth",r.observed);written++;
      }
    })();
  }
  return {written};
}
export function milestoneProjection(db:Database.Database,m:Milestone,window:string,asOfDate:string) {
  validateMilestoneIdentity(db,m);
  if(!(window in windows))throw Error("invalid milestone window");
  const rows=db.prepare(`SELECT date,units,signal,basis FROM steam_unit_calibration_daily
    WHERE milestone_id=? AND date<=? ORDER BY date`).all(m.id,asOfDate) as any[];
  const latest=rows.at(-1)?.date as string|undefined;
  if(!latest||latest<m.asOfDate)return null;
  const end=dateMs(latest),days=windows[window],start=Math.max(dateMs(m.startDate),days==null?-Infinity:end-(days-1)*DAY);
  const selected=rows.filter(r=>dateMs(r.date)>=start);
  // Do not turn a missing activity day into zero, or allocate a coarse week to days.
  const complete=selected.length===(end-start)/DAY+1;
  return {units:complete?selected.reduce((s,r)=>s+r.units,0):null,
    asOfDate:latest,complete,days:selected,sourceUrl:m.sourceUrl,milestoneId:m.id,
    caveat:`Estimated revenue and daily sales pattern calibrated to at least ${m.units.toLocaleString("en-US")} publicly reported Steam copies on ${m.asOfDate}. Revenue and individual-day sales were not reported. Steam CCU learning remains shadow-only.`};
}
/** Only the explicitly audited legacy assumption is superseded. */
export function milestoneCanOverlay(db:Database.Database,m:Milestone,window:string) {
  const override=db.prepare(`SELECT * FROM title_multiplier_overrides WHERE title_id=? AND platform='steam'
    AND effective_from<=? ORDER BY effective_from DESC LIMIT 1`).get(m.titleId,new Date().toISOString()) as any;
  if(override&&(override.effective_from!==m.supersededOverride.effectiveFrom||
    override.multiplier!==m.supersededOverride.multiplier||override.method!==m.supersededOverride.method))
    return false;
  const anchors=db.prepare(`SELECT * FROM revenue_calibration_anchors
    WHERE title_id=? AND platform='steam' AND (window=? OR window='ltd')`).all(m.titleId,window) as any[];
  return anchors.every(a=>a.id===m.supersededAnchor.id&&
    a.as_of_date===m.supersededAnchor.date&&a.data_source===m.supersededAnchor.source&&
    a.actual_units===m.supersededAnchor.units&&a.actual_revenue_usd===m.supersededAnchor.revenue);
}
