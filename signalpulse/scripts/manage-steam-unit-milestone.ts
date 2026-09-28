/**
 * Explicit operator activation only. Not invoked by deploy/startup/daily jobs.
 * audit is read-only; apply preserves every pre-existing sales/source table.
 * rollback deactivates this layer without erasing evidence or fresh raw writes.
 */
import Database from "better-sqlite3";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {initSteamUnitCalibration,installMilestone,refreshSteamUnitCalibration,
  validateMilestoneIdentity,validateMilestone,milestoneProjection,type Milestone} from "../server/steam-unit-calibration";
const action=process.argv[2]??"audit";
if(!["audit","apply","rollback"].includes(action))throw Error("action must be audit, apply or rollback");
const manifest=process.argv[3]??fileURLToPath(new URL("./wardogs-milestone-2026-09-26.json",import.meta.url));
const m:Milestone=JSON.parse(readFileSync(manifest,"utf8"));
const hash=createHash("sha256").update(JSON.stringify(m)).digest("hex");
const db=new Database(process.env.STEAM_MILESTONE_DB??"data.db",{readonly:action==="audit",fileMustExist:true});
db.pragma("busy_timeout=5000");
const before={
  anchors:db.prepare("SELECT * FROM revenue_calibration_anchors WHERE title_id=? AND platform='steam' ORDER BY id").all(m.titleId),
  overrides:db.prepare("SELECT * FROM title_multiplier_overrides WHERE title_id=? AND platform='steam' ORDER BY id").all(m.titleId),
  state:db.prepare("SELECT * FROM title_ltd_state WHERE title_id=? AND platform='steam'").get(m.titleId),
};
validateMilestoneIdentity(db,m);
if(action!=="audit"){
  if(process.env.APPROVED_MILESTONE_SHA256!==hash)throw Error("explicit approved manifest hash required");
  initSteamUnitCalibration(db);
  if(action==="apply")db.transaction(()=>{
    installMilestone(db,m);
    refreshSteamUnitCalibration(db,new Date().toISOString().slice(0,10));
  })();
  else db.transaction(()=>{
    const r=db.prepare("SELECT payload_json FROM steam_unit_milestones WHERE id=?").get(m.id) as any;
    if(!r||r.payload_json!==JSON.stringify(m))throw Error("rollback manifest mismatch");
    db.prepare("UPDATE steam_unit_milestones SET active=0 WHERE id=?").run(m.id);
  })();
}
const exists=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='steam_unit_milestones'").get();
console.log(JSON.stringify({action,manifestSha256:hash,before,calibration:validateMilestone(m),
  active:exists?db.prepare("SELECT id,active FROM steam_unit_milestones WHERE id=?").get(m.id):null,
  projections:exists?Object.fromEntries(["d7","d30","d90","m12","ltd"].map(w=>
    [w,milestoneProjection(db,m,w,new Date().toISOString().slice(0,10))])):null},null,2));
db.close();
