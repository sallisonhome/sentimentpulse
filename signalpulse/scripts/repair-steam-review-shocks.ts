import Database from "better-sqlite3";
import {mkdirSync,existsSync} from "node:fs";
import {resolve,join} from "node:path";
import {planReviewShockRepair,applyReviewShockRepair,rollbackReviewShockRepair} from "../server/steam-review-shock-repair";
const args=process.argv.slice(2),value=(key:string)=>args[args.indexOf(key)+1];
const apply=args.includes("--apply"),rollback=args.includes("--rollback");
if(apply&&rollback)throw Error("Choose apply or rollback");
const db=new Database(resolve(process.env.DB_PATH??"data.db"),{readonly:!apply&&!rollback,fileMustExist:true});
db.pragma("busy_timeout=10000");
try{
  const plan=planReviewShockRepair(db,process.env.AS_OF??new Date().toISOString().slice(0,10));
  if(!apply&&!rollback)console.log(JSON.stringify(plan,null,2));
  else{
    if(!args.includes("--confirm")||value("--confirm")!=="CONFIRM")throw Error("Explicit confirmation required");
    if(apply&&(!args.includes("--expected-sha")||value("--expected-sha")!==plan.sha256))throw Error("Fresh reviewed manifest SHA required");
    if(rollback&&(!args.includes("--run-id")||!value("--run-id")))throw Error("Run ID required");
    const runId=new Date().toISOString().replace(/[:.]/g,"-"),dir=resolve(process.env.BACKUP_DIR??"repair-backups");
    mkdirSync(dir,{recursive:true,mode:0o700});
    const backup=join(dir,`steam-review-shocks-${runId}.db`);
    if(existsSync(backup))throw Error("Backup exists");
    await db.backup(backup);
    const result=rollback?rollbackReviewShockRepair(db,value("--run-id")):applyReviewShockRepair(db,plan,runId);
    console.log(JSON.stringify({...result,backup,planSha:plan.sha256}));
  }
}finally{db.close();}
