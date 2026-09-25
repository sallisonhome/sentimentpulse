import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {planLifetimeSeedRepair} from "./lifetime-seed-repair";
import {planSteamLtdRepair} from "./steam-ltd-overlap-repair";
import {planLifetimeWindowFloorRepair} from "./lifetime-window-floor-repair";

type Row=Record<string,any>;
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function planLifetimeCatalogRepair(db:Database.Database,asOf:string){
  const seed=planLifetimeSeedRepair(db,asOf),overlap=planSteamLtdRepair(db,asOf),floor=planLifetimeWindowFloorRepair(db,asOf);
  const entries:Row[]=[
    ...seed.entries.filter(e=>e.status==="repair").map(e=>({...e,kind:"initial_seed"})),
    ...overlap.entries.filter(e=>e.status==="repair").map(e=>{
      const history=db.prepare("SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam' AND window='ltd' AND as_of_date<=? ORDER BY as_of_date").all(e.titleId,asOf) as Row[];
      const coefficient=Number(e.evidence!.multiplier)/Number(e.evidence!.digitalShare);
      let floor=0;
      const estimateChanges:Row[]=[];
      for(const row of history){
        if(row.gated_reason || row.signal_value==null)continue;
        floor=Math.max(floor,Math.round(row.signal_value*coefficient));
        if(!String(row.method).includes("+ltd_state:derived_max_windows") || row.units_mid<=floor)continue;
        const units=floor,scale=units/row.units_mid;
        estimateChanges.push({before:row,after:{...row,units_mid:units,
          owners_mid:row.owners_mid==null?null:Math.round(row.owners_mid*scale),
          owners_low:row.owners_low==null?null:Math.round(row.owners_low*scale),
          owners_high:row.owners_high==null?null:Math.round(row.owners_high*scale),
          method:row.method+"+overlap_repaired_v1"}});
      }
      return {...e,platform:"steam",kind:"review_overlap",estimateChanges};
    }),
    ...floor.entries.filter(e=>e.status==="repair").map(e=>({...e,kind:"window_floor"})),
  ].sort((a,b)=>a.titleId-b.titleId||a.platform.localeCompare(b.platform));
  if(new Set(entries.map(e=>`${e.titleId}|${e.platform}`)).size!==entries.length)throw Error("Overlapping repair scopes");
  const summarize=(p:{entries:{reason:string}[]})=>p.entries.reduce((a,e)=>(a[e.reason]=(a[e.reason]??0)+1,a),{} as Record<string,number>);
  const body={version:"lifetime-catalog-integrity-v1",asOf,entries,audit:{
    stateCount:seed.entries.length,seed:summarize(seed),overlap:summarize(overlap),floor:summarize(floor)}};
  return {...body,sha256:hash(body)};
}
type Plan=ReturnType<typeof planLifetimeCatalogRepair>;
function state(db:Database.Database,r:Row){
  db.prepare("UPDATE title_ltd_state SET ltd_units=?,ltd_source=?,last_signal_value=?,last_updated_iso=?,seeded_from=? WHERE title_id=? AND platform=?")
    .run(r.ltd_units,r.ltd_source,r.last_signal_value,r.last_updated_iso,r.seeded_from,r.title_id,r.platform);
}
function estimate(db:Database.Database,r:Row){
  db.prepare("UPDATE window_estimates_daily SET units_mid=?,owners_mid=?,owners_low=?,owners_high=?,method=? WHERE id=?")
    .run(r.units_mid,r.owners_mid,r.owners_low,r.owners_high,r.method,r.id);
}
export function applyLifetimeCatalogRepair(db:Database.Database,approved:Plan,runId:string){
  return db.transaction(()=>{
    const {sha256,...body}=approved;
    if(hash(body)!==sha256 || planLifetimeCatalogRepair(db,approved.asOf).sha256!==sha256)throw Error("Repair plan changed");
    db.exec(`CREATE TABLE IF NOT EXISTS lifetime_catalog_repair_audit(
      run_id TEXT NOT NULL,title_id INTEGER NOT NULL,platform TEXT NOT NULL,plan_sha TEXT NOT NULL,
      change_json TEXT NOT NULL,applied_at TEXT NOT NULL,rolled_back_at TEXT,
      PRIMARY KEY(run_id,title_id,platform))`);
    for(const e of approved.entries){
      const stamp=new Date().toISOString(),change={...e,after:{...e.after,last_updated_iso:stamp}};
      db.prepare("INSERT INTO lifetime_catalog_repair_audit VALUES(?,?,?,?,?,?,NULL)")
        .run(runId,e.titleId,e.platform,sha256,JSON.stringify(change),stamp);
      state(db,change.after);
      for(const row of e.estimateChanges??[])estimate(db,row.after);
    }
    return {runId,repaired:approved.entries.length,historicalRows:approved.entries.reduce((n,e)=>n+(e.estimateChanges?.length??0),0)};
  }).immediate();
}
export function rollbackLifetimeCatalogRepair(db:Database.Database,runId:string){
  return db.transaction(()=>{
    const rows=db.prepare("SELECT * FROM lifetime_catalog_repair_audit WHERE run_id=? AND rolled_back_at IS NULL").all(runId) as Row[];
    if(!rows.length)throw Error("No active repair rows");
    const changes=rows.map(r=>JSON.parse(r.change_json));
    for(const e of changes){
      const now=db.prepare("SELECT * FROM title_ltd_state WHERE title_id=? AND platform=?").get(e.titleId,e.platform);
      if(JSON.stringify(now)!==JSON.stringify(e.after))throw Error("Intervening state write; refusing rollback");
      for(const row of e.estimateChanges??[]){
        const now=db.prepare("SELECT * FROM window_estimates_daily WHERE id=?").get(row.after.id);
        if(JSON.stringify(now)!==JSON.stringify(row.after))throw Error("Intervening estimate write; refusing rollback");
      }
    }
    for(const e of changes){
      state(db,e.before);
      for(const row of e.estimateChanges??[])estimate(db,row.before);
      db.prepare("UPDATE lifetime_catalog_repair_audit SET rolled_back_at=? WHERE run_id=? AND title_id=? AND platform=?")
        .run(new Date().toISOString(),runId,e.titleId,e.platform);
    }
    return {runId,restored:changes.length};
  }).immediate();
}
