/**
 * Daily, verified catalog completion independent of top-N rankings.
 * Runs inside the daily runner's maintenance lock BEFORE signal collection.
 * No destructive merges or copied rating/history rows.
 */
import { mkdirSync,writeFileSync,renameSync,readdirSync,readFileSync,unlinkSync } from "node:fs";
import { join,resolve } from "node:path";
import { rawSqlite as db,storage } from "../server/storage";
import { loadSalesCatalog,planSalesCoverage,applySalesCoverage,rollbackSalesCoverage } from "../server/sales-catalog-reconcile";

async function main(){
  const rollbackIndex=process.argv.indexOf("--rollback");
  if(rollbackIndex>=0){
    if(storage.getSetting("sales_catalog_reconcile_mode")?.value!=="off")
      throw Error("Set sales_catalog_reconcile_mode=off before rollback");
    const file=process.argv[rollbackIndex+1];
    if(!file)throw Error("--rollback requires a completed receipt file");
    const receipt=JSON.parse(readFileSync(resolve(file),"utf8"));
    if(receipt.version!==1 || receipt.mode!=="active" || receipt.status!=="complete" || !Array.isArray(receipt.applied))
      throw Error("Not a completed active coverage receipt");
    console.log("Catalog fields rolled back:",rollbackSalesCoverage(db,receipt.applied));
    console.log("Run the existing locked daily refresh to recalculate derived estimates; do not restore the whole DB.");
    return;
  }
  const mode=process.argv.includes("--plan")?"plan":
    process.env.SALES_CATALOG_RECONCILE_MODE ??
    storage.getSetting("sales_catalog_reconcile_mode")?.value ?? "active";
  if(!["off","plan","active"].includes(mode))throw Error("Invalid sales_catalog_reconcile_mode");
  if(mode==="off"){console.log("SALES COVERAGE DISABLED: no catalog writes");return;}
  const stamp=new Date().toISOString(),dir=resolve("catalog-coverage-audit");
  mkdirSync(dir,{recursive:true});
  const path=join(dir,stamp.replace(/[:.]/g,"-")+".json");
  const decisions=await planSalesCoverage(loadSalesCatalog(db),undefined,{
    deadlineMs:Date.now()+180_000,rotationOffset:Math.floor(Date.now()/86400_000)*97,
  });
  const proposed=decisions.filter(d=>d.status==="promote").length;
  const receipt:any={version:1,startedAt:stamp,mode,status:"prepared",decisions,applied:[]};
  const save=()=>{writeFileSync(path+".tmp",JSON.stringify(receipt,null,2));renameSync(path+".tmp",path);};
  save(); // Durable before-image exists BEFORE the transaction.
  if(mode==="active" && proposed){
    receipt.backup=path+".db";
    await db.backup(receipt.backup);
    save();
    receipt.applied=applySalesCoverage(db,decisions);
  }
  receipt.status="complete";
  receipt.coverageStatus=decisions.some(d=>d.status==="error"||d.status==="deferred")?"partial":"complete";
  receipt.completedAt=new Date().toISOString();save();
  // Keep the newest three completed backups owned by this job, retaining every
  // small JSON receipt. Never purge unrelated or interrupted-run backups.
  const backups=readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(f))
    .sort().reverse().flatMap(f=>{
      try{const r=JSON.parse(readFileSync(join(dir,f),"utf8"));
        return r.version===1 && r.status==="complete" && r.backup===join(dir,f)+".db" ? [r.backup] : [];
      }catch{return [];}
    });
  for(const backup of backups.slice(3)){
    try{unlinkSync(backup);}catch(e:any){if(e.code!=="ENOENT")throw e;}
  }
  const counts=Object.fromEntries(["promote","covered","hold","error","deferred"].map(s=>[s,decisions.filter(d=>d.status===s).length]));
  console.log(JSON.stringify({mode,path,counts,applied:receipt.applied.length}));
  for(const d of decisions)console.log(JSON.stringify({platform:d.before.platform,title:d.before.name,
    sku:d.before.external_sku,status:d.status,reason:d.reason,coveredBy:d.coveredBy}));
  console.log(`SALES COVERAGE ${receipt.coverageStatus.toUpperCase()}: ambiguous/unavailable SKUs held; existing sales rows unchanged`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
