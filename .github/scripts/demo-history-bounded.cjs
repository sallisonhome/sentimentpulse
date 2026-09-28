const {spawn}=require("node:child_process"),fs=require("node:fs");
const Database=require(process.cwd()+"/node_modules/better-sqlite3");
exports.run=async expected=>{
  const easternHour=()=>Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",hourCycle:"h23"}).format(new Date()));
  if(easternHour()>=1&&easternHour()<8)throw Error("Outside the safe work window; daily schedule must not overlap");
  const dir="/tmp/demo-review-priority-sep28-batches";fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const db=new Database("data.db",{readonly:true});
  // An already completed authorized invocation is inspected, never blindly
  // replayed after an SSH disconnect or workflow retry.
  const statePath="/tmp/demo-review-priority-sep28-window.json";
  if(fs.existsSync(statePath))throw Error("This authorized continuation already started; inspect rather than replay");
  const started=Date.now(),deadline=started+3600000;
  fs.writeFileSync(statePath,JSON.stringify({expected,startedAt:new Date(started).toISOString(),deadline:new Date(deadline).toISOString(),status:"running"}),{mode:0o600});
  let batches=0,stopReason="one-hour review-priority window reached",requests=0;
  try{
    while(Date.now()+30000<deadline){
      if(easternHour()>=1&&easternHour()<8){stopReason="approaching morning collection window";break;}
      const ms=Math.min(240000,deadline-Date.now()-15000);
      const file=`${dir}/batch-${String(batches+1).padStart(3,"0")}.json`;
      await new Promise((resolve,reject)=>{
        const out=fs.openSync(file,"w",0o600);
        const child=spawn("node_modules/.bin/tsx",["--tsconfig","tsconfig.json","/tmp/demo-history-resume.mts","200",String(ms)],
          {env:{...process.env,DEMO_HISTORY_MAINTENANCE_LOCK:"1"},stdio:["ignore",out,"inherit"]});
        child.once("error",e=>{fs.closeSync(out);reject(e);});
        child.once("exit",code=>{fs.closeSync(out);code===0?resolve():reject(Error(`Backfill child exited ${code}`));});
      });
      const r=JSON.parse(fs.readFileSync(file,"utf8"));batches++;requests+=r.result.requests;
      const counts=db.prepare("SELECT kind,status,COUNT(*) n FROM demo_history_backfill_jobs GROUP BY kind,status").all();
      console.log(JSON.stringify({phase:"batch",batch:batches,at:new Date().toISOString(),result:r.result,counts}));
      if(r.result.stopReason){stopReason=r.result.stopReason;break;}
      const pending=db.prepare("SELECT COUNT(*) n FROM demo_history_backfill_jobs WHERE kind='reviews' AND status IN ('pending','running')").get().n;
      if(!pending){stopReason="all runnable review jobs finished; inspect errors and mismatches";break;}
      if(r.result.requests===0){stopReason="no progress; checkpoint retained";break;}
    }
  }catch(e){
    stopReason="operator batch failed; inspect before any continuation";
    throw e;
  }finally{
    db.close();
    const state={expected,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),batches,requests,stopReason,status:"stopped"};
    fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600});console.log(JSON.stringify({phase:"work-window",...state}));
  }
};
