import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { reviewWindow } from "./steam-review-windows";

type Row = Record<string, any>;
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const all = (db: Database.Database, sql: string, ...args: any[]) => db.prepare(sql).all(...args) as Row[];
export const FLOOR_REPAIR_VERSION = "lifetime-impossible-window-floor-v1";

/**
 * Prove an impossible modeled window was retained as a lifetime floor by
 * replaying BOTH the original and corrected state transitions exactly.
 * Not a universal rebase. Unknown histories, coefficients and overrides stop.
 */
export function planLifetimeWindowFloorRepair(db: Database.Database, asOf: string) {
  reviewWindow([], asOf, 7);
  const entries = all(db, "SELECT * FROM title_ltd_state ORDER BY title_id,platform").map(before => {
    const id = before.title_id, p = before.platform;
    const meta = db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(id) as Row | undefined;
    const entry = { titleId:id, platform:p, name:meta?.store_name??meta?.name, before, status:"skip", reason:"" };
    const skip = (reason:string) => ({...entry,reason});
    if (!["derived_max_windows","accumulator"].includes(before.ltd_source) ||
      (before.seeded_from && !String(before.seeded_from).startsWith("option_b_replay_")) ||
      (p==="steam" && before.ltd_source!=="accumulator")) return skip("protected_or_separate_repair");
    if (db.prepare("SELECT 1 FROM revenue_calibration_anchors WHERE title_id=?").get(id) ||
      db.prepare("SELECT 1 FROM title_multiplier_overrides WHERE title_id=?").get(id) ||
      db.prepare("SELECT 1 FROM platform_sku_map WHERE title_id=? AND is_manual_override=1").get(id))
      return skip("protected_anchor_or_override");
    const maps=all(db,"SELECT DISTINCT external_sku FROM platform_sku_map WHERE title_id=? AND platform=? AND sku_role='base' AND business_model='paid'",id,p);
    if(maps.length!==1)return skip("ambiguous_identity");
    const history=all(db,"SELECT * FROM window_estimates_daily WHERE title_id=? AND platform=? AND as_of_date<=? ORDER BY as_of_date,window",id,p,asOf);
    const ltd=history.filter(r=>r.window==="ltd" && r.units_mid!=null && !r.gated_reason);
    const firstIndex=ltd.findIndex(r=>String(r.method).includes("+ltd_state:"));
    if(firstIndex<0)return skip("missing_state_history");
    const trajectory=ltd.slice(firstIndex),first=trajectory[0],prior=ltd[firstIndex-1];
    const active=db.prepare("SELECT * FROM ownership_multipliers WHERE platform=? AND cohort_key='default' AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(p,asOf+"T23:59:59Z") as Row|undefined;
    if(!active || !(active.multiplier>0) || !(active.digital_unit_share>0))return skip("missing_multiplier");
    const coeff=active.multiplier/active.digital_unit_share;
    const snap=db.prepare("SELECT * FROM store_rating_signal_daily WHERE title_id=? AND platform=? AND capture_date<=? ORDER BY capture_date DESC LIMIT 1").get(id,p,asOf) as Row|undefined;
    if(!snap || Date.parse(asOf)-Date.parse(snap.capture_date)>2*86400000 ||
      snap.rating_count!==trajectory.at(-1)!.signal_value)return skip("stale_or_mismatched_signal");
    if(p==="steam"){
      const buckets=all(db,"SELECT * FROM steam_review_history WHERE app_id=?",maps[0].external_sku);
      let grain;try{grain=JSON.parse(snap.raw_json??"{}").rollup_type;}catch{}
      const histogram=reviewWindow(buckets as any,snap.capture_date,null,grain);
      if(!histogram.discardedOverlaps || histogram.signal!==snap.rating_count)return skip("unreconciled_histogram");
    }
    const witnesses:Row[]=[];
    const windows=(l:Row,correct:boolean)=>{
      const wins=history.filter(r=>r.as_of_date===l.as_of_date && r.window!=="ltd" && !r.gated_reason && r.units_mid!=null);
      return wins.map(w=>{
        const exact=Math.abs(w.units_mid-Math.round(w.signal_value*coeff))<=1;
        const invalid=w.multiplier_id===active.id && exact && w.signal_value>l.signal_value &&
          (p==="steam" ? String(w.method).startsWith("calibrated_from_actuals") : w.method==="backfill-observed-pace");
        if(invalid && !correct)witnesses.push({date:w.as_of_date,window:w.window,signal:w.signal_value,lifetimeSignal:l.signal_value});
        return correct&&invalid ? Math.round(l.signal_value*coeff) : w.units_mid;
      });
    };
    let original=0,corrected=0,previous:Row|undefined;
    // The legacy seed ran against the previous saved date for some mature
    // titles. Only admit that path when its exact max-window arithmetic fits.
    if(prior && before.seeded_from && prior.multiplier_id===active.id){
      original=Math.max(Math.round(prior.signal_value*coeff),...windows(prior,false));
      corrected=Math.max(Math.round(prior.signal_value*coeff),...windows(prior,true));
      previous=prior;
    }
    const estimateChanges:Row[]=[];
    for(const row of trajectory){
      const method=String(row.method);
      if(row.multiplier_id!==active.id || !Number.isSafeInteger(row.signal_value) || row.signal_value<0 ||
        !Number.isSafeInteger(row.units_mid) || row.units_mid<0 ||
        !/\+ltd_state:(derived_max_windows|accumulator)$/.test(method) ||
        (previous && method.endsWith(":accumulator") && row.signal_value<previous.signal_value))return skip("unexplained_trajectory");
      const naive=Math.round(row.signal_value*coeff);
      if(method.endsWith(":derived_max_windows")){
        original=Math.max(original,naive,...windows(row,false));
        corrected=Math.max(corrected,naive,...windows(row,true));
      }else if(previous && (String(previous.method).endsWith(":accumulator") ||
        (row===first && before.seeded_from && prior))){
        const delta=(row.signal_value-previous.signal_value)*coeff;
        original=Math.round(original+delta);corrected=Math.round(corrected+delta);
      }else{
        const base=Math.max(original,naive),cleanBase=Math.max(corrected,naive);
        // A state can transition on a missing estimate date. Accept only an
        // exactly proven positive increment across that gap, not an arbitrary
        // unexplained jump or same-day transition.
        const gap=previous ? (Date.parse(row.as_of_date)-Date.parse(previous.as_of_date))/86400000 : 0;
        const delta=previous ? (row.signal_value-previous.signal_value)*coeff : 0;
        if(previous && gap>1 && Math.abs(row.units_mid-Math.round(original+delta))<=1 &&
          row.units_mid>base){
          original=Math.round(original+delta);corrected=Math.round(corrected+delta);
        }else{original=base;corrected=cleanBase;}
      }
      if(Math.abs(original-row.units_mid)>1)return skip("original_replay_mismatch");
      // Preserve actual historical rounding once the original replay is proved.
      corrected+=row.units_mid-original;original=row.units_mid;
      if(corrected<0 || corrected>original)return skip("invalid_corrected_trajectory");
      if(corrected!==row.units_mid){
        const scale=corrected/row.units_mid;
        estimateChanges.push({before:row,after:{...row,units_mid:corrected,
          owners_mid:row.owners_mid==null?null:Math.round(row.owners_mid*scale),
          owners_low:row.owners_low==null?null:Math.round(row.owners_low*scale),
          owners_high:row.owners_high==null?null:Math.round(row.owners_high*scale),
          method:row.method+"+window_floor_repaired_v1"}});
      }
      previous=row;
    }
    if(original!==before.ltd_units || before.last_signal_value!==snap.rating_count)return skip("state_history_mismatch");
    if(!witnesses.length || corrected>=original)return skip("no_proven_excess");
    return {...entry,status:"repair",reason:"exact_replay_of_impossible_window_floor",
      after:{...before,ltd_units:corrected,seeded_from:FLOOR_REPAIR_VERSION},estimateChanges,
      evidence:{coefficient:coeff,multiplierId:active.id,witnesses,original,corrected}};
  });
  const body={version:FLOOR_REPAIR_VERSION,asOf,entries};
  return {...body,sha256:hash(body)};
}
