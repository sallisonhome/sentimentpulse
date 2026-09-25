import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {reviewShockEvidence} from "./steam-review-shocks";
import {reviewWindow,type ReviewBucket} from "./steam-review-windows";
export const SHOCK_REPAIR_VERSION="steam-review-shock-state-v1";
type DB=Database.Database;
type State={title_id:number;platform:string;ltd_units:number;ltd_source:string;
  last_signal_value:number|null;last_updated_iso:string;seeded_from:string|null};
type Entry={titleId:number;name:string;status:"repair"|"skip";reason:string;before:State;
  after?:State;evidence?:Record<string,unknown>};
export type ShockRepairPlan={version:string;asOfDate:string;entries:Entry[];sha256:string};
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reconcile only proven review-shock increments, never rebase mature lifetime sales. */
export function planReviewShockRepair(db:DB,asOfDate:string):ShockRepairPlan{
  reviewWindow([],asOfDate,7);
  const states=db.prepare("SELECT * FROM title_ltd_state WHERE platform='steam' ORDER BY title_id").all() as State[];
  const entries:Entry[]=[];
  for(const state of states){
    const psm=db.prepare(`SELECT DISTINCT external_sku FROM platform_sku_map
      WHERE title_id=? AND platform='steam' AND sku_role='base' AND business_model='paid'`).all(state.title_id) as any[];
    const meta=db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(state.title_id) as any;
    const entry:Entry={titleId:state.title_id,name:meta?.store_name??meta?.name??String(state.title_id),
      status:"skip",reason:"",before:state};
    const skip=(reason:string)=>{entries.push({...entry,reason});};
    if(psm.length!==1){skip("ambiguous_or_missing_paid_base_app");continue;}
    const snapshot=db.prepare(`SELECT * FROM store_rating_signal_daily WHERE title_id=? AND platform='steam'
      AND capture_date<=? ORDER BY capture_date DESC LIMIT 1`).get(state.title_id,asOfDate) as any;
    if(!snapshot||Date.parse(asOfDate)-Date.parse(snapshot.capture_date)>2*86400000){skip("stale_or_missing_snapshot");continue;}
    const buckets=db.prepare("SELECT * FROM steam_review_history WHERE app_id=?").all(psm[0].external_sku) as ReviewBucket[];
    const release=meta?.match_confidence==="low"?meta?.store_release_date:meta?.release_date??meta?.store_release_date;
    const shock=reviewShockEvidence(buckets,snapshot.capture_date,release??null);
    if(!shock.events.length){skip("no_review_shock");continue;}
    if(shock.invalid){skip("inconsistent_event_rollup");continue;}
    if(state.ltd_source!=="accumulator"){skip("not_mature_accumulator");continue;}
    if(db.prepare("SELECT 1 FROM revenue_calibration_anchors WHERE title_id=? LIMIT 1").get(state.title_id)||
       db.prepare("SELECT 1 FROM title_multiplier_overrides WHERE title_id=? LIMIT 1").get(state.title_id)||
       db.prepare("SELECT 1 FROM platform_sku_map WHERE title_id=? AND is_manual_override=1 LIMIT 1").get(state.title_id)){
      skip("protected_anchor_or_override");continue;
    }
    let grain;try{grain=JSON.parse(snapshot.raw_json??"{}").rollup_type;}catch{}
    if(reviewWindow(buckets,snapshot.capture_date,null,grain).signal!==snapshot.rating_count){
      skip("histogram_snapshot_mismatch");continue;
    }
    const history=db.prepare(`SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam'
      AND window='ltd' AND gated_reason IS NULL AND as_of_date<=? ORDER BY as_of_date`).all(state.title_id,asOfDate) as any[];
    const latest=history.at(-1);
    if(!latest||state.ltd_units!==latest.units_mid||state.last_signal_value!==latest.signal_value||
       latest.signal_value!==snapshot.rating_count){skip("state_does_not_match_raw_evidence");continue;}
    const first=shock.events[0].date;
    const base=history.filter(r=>r.as_of_date<first).at(-1);
    if(!base||Date.parse(first)-Date.parse(base.as_of_date)>3*86400000||
       !String(base.method).includes("ltd_state:accumulator")){
      skip("missing_pre_event_accumulator");continue;
    }
    const rows=history.filter(r=>r.as_of_date>=base.as_of_date);
    const mult=db.prepare("SELECT * FROM ownership_multipliers WHERE id=?").get(base.multiplier_id) as any;
    const active=db.prepare(`SELECT * FROM ownership_multipliers WHERE platform='steam' AND cohort_key='default'
      AND effective_from<=? ORDER BY effective_from DESC LIMIT 1`).get(asOfDate+"T23:59:59Z") as any;
    if(!mult||mult.id!==active?.id||!(mult.multiplier>0)||!(mult.digital_unit_share>0)){
      skip("coefficient_changed");continue;
    }
    let proven=true;
    for(let i=0;i<rows.length;i++){
      const r=rows[i],prior=rows[i-1];
      if(!Number.isSafeInteger(r.signal_value)||r.signal_value<0||!Number.isFinite(r.units_mid)||
         r.multiplier_id!==mult.id||!String(r.method).includes("ltd_state:accumulator")){proven=false;break;}
      if(prior&&(r.signal_value<prior.signal_value||
         Math.abs(r.units_mid-Math.round(prior.units_mid+(r.signal_value-prior.signal_value)*mult.multiplier/mult.digital_unit_share))>1)){
        proven=false;break;
      }
    }
    if(!proven){skip("unexplained_intervening_history");continue;}
    const adjusted=snapshot.rating_count-shock.excludedActivity;
    if(adjusted<base.signal_value){skip("adjusted_signal_precedes_base");continue;}
    const target=Math.round(base.units_mid+(adjusted-base.signal_value)*mult.multiplier/mult.digital_unit_share);
    if(target>=state.ltd_units){skip("no_inflated_increment");continue;}
    entries.push({...entry,status:"repair",reason:"proven_review_shock_increment",
      after:{...state,ltd_units:target,last_signal_value:adjusted,seeded_from:SHOCK_REPAIR_VERSION},
      evidence:{appId:psm[0].external_sku,baseDate:base.as_of_date,baseUnits:base.units_mid,
        baseSignal:base.signal_value,rawSnapshot:snapshot.rating_count,adjustedSignal:adjusted,
        multiplierId:mult.id,multiplier:mult.multiplier,digitalShare:mult.digital_unit_share,events:shock.events}});
  }
  const body={version:SHOCK_REPAIR_VERSION,asOfDate,entries};
  return {...body,sha256:hash(body)};
}
function write(db:DB,s:State){
  db.prepare(`UPDATE title_ltd_state SET ltd_units=?,ltd_source=?,last_signal_value=?,last_updated_iso=?,seeded_from=?
    WHERE title_id=? AND platform='steam'`).run(s.ltd_units,s.ltd_source,s.last_signal_value,s.last_updated_iso,s.seeded_from,s.title_id);
}
export function applyReviewShockRepair(db:DB,plan:ShockRepairPlan,runId:string){
  return db.transaction(()=>{
    const {sha256,...body}=plan;
    if(hash(body)!==sha256)throw Error("Repair plan changed");
    if(planReviewShockRepair(db,plan.asOfDate).sha256!==plan.sha256)throw Error("Repair plan changed");
    db.exec(`CREATE TABLE IF NOT EXISTS steam_review_shock_repair_audit(
      run_id TEXT NOT NULL,title_id INTEGER NOT NULL,plan_sha TEXT NOT NULL,
      before_json TEXT NOT NULL,after_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
      applied_at TEXT NOT NULL,rolled_back_at TEXT,PRIMARY KEY(run_id,title_id))`);
    const repairs=plan.entries.filter(e=>e.status==="repair"),stamp=new Date().toISOString();
    for(const e of repairs){
      const after={...e.after!,last_updated_iso:stamp};
      db.prepare("INSERT INTO steam_review_shock_repair_audit VALUES(?,?,?,?,?,?,?,NULL)")
        .run(runId,e.titleId,plan.sha256,JSON.stringify(e.before),JSON.stringify(after),JSON.stringify(e.evidence),stamp);
      write(db,after);
    }
    return {runId,repaired:repairs.length};
  }).immediate();
}
export function rollbackReviewShockRepair(db:DB,runId:string){
  return db.transaction(()=>{
    const rows=db.prepare("SELECT * FROM steam_review_shock_repair_audit WHERE run_id=? AND rolled_back_at IS NULL ORDER BY title_id").all(runId) as any[];
    if(!rows.length)throw Error("No active repair rows");
    for(const r of rows){
      const current=db.prepare("SELECT * FROM title_ltd_state WHERE title_id=? AND platform='steam'").get(r.title_id);
      if(JSON.stringify(current)!==r.after_json)throw Error("Intervening state write; refusing rollback");
    }
    for(const r of rows){
      write(db,JSON.parse(r.before_json));
      db.prepare("UPDATE steam_review_shock_repair_audit SET rolled_back_at=? WHERE run_id=? AND title_id=?")
        .run(new Date().toISOString(),runId,r.title_id);
    }
    return {restored:rows.length,runId};
  }).immediate();
}
