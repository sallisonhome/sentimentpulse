#!/usr/bin/env node
// Build a READ-ONLY offline route runner. No production URL or app startup.
// Usage: node scripts/profile-buying-offline.mjs --source <signalpulse-root>
//   --db <snapshot.db> --out <new-output-dir> [--date ISO] [--full] [--path /api/...]
import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const home = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(option("--source") ?? home);
const db = resolve(option("--db") ?? "");
const out = resolve(option("--out") ?? "");
if (!option("--db") || !option("--out") || !existsSync(db) || existsSync(out))
  throw Error("Require existing --db and NEW --out directory");
mkdirSync(out, { recursive: true, mode: 0o700 });
const sourceFile = resolve(source, "server/routes-console-leaderboards.ts");
const manifest = option("--manifest") ? JSON.parse(readFileSync(option("--manifest"),"utf8")) : null;
const date = option("--date") ?? manifest?.captured_at ?? new Date().toISOString();
async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const beforeHash = await fileHash(db);
if (manifest && manifest.snapshot_sha256 !== beforeHash) throw Error("Snapshot hash mismatch");
const modes = {};
if (manifest) for (const key of ["CHART_CONSISTENCY_MODE","FC26_RECENT_FAMILY_ENABLED",
  "DAILY_GAP_ALLOCATION_ENABLED","LAUNCH_DAILY_RECONSTRUCTION_ENABLED","STEAM_UNIT_CALIBRATION_ENABLED"]) {
  const value = manifest.effective_modes?.[key];
  if (!(key === "CHART_CONSISTENCY_MODE" ? ["off","report","enforce"] : ["0","1"]).includes(value))
    throw Error("Missing/invalid manifest semantic mode: "+key);
  modes[key] = value;
}
const storageShim = `
import Database from "better-sqlite3";
import {metadataMatchesStorefront} from ${JSON.stringify(resolve(source,"server/console-title-identity.ts"))};
export const rawSqlite = new Database(process.env.PROFILE_DB,{readonly:true,fileMustExist:true});
export const storage = new Proxy({}, {get(){throw Error("Offline board profiling forbids application storage helpers");}});
rawSqlite.pragma("query_only=ON");
const stats=globalThis.__buyingProfile={udfCalls:0,prepareCalls:0,prepareMs:0,queries:new Map()};
const timingOnly=${args.includes("--timing-only")};
rawSqlite.function("console_identity_matches",{deterministic:true},timingOnly
 ? (a,b)=>Number(metadataMatchesStorefront(a,b))
 : (a,b)=>{stats.udfCalls++;return Number(metadataMatchesStorefront(a,b));});
const prepare=rawSqlite.prepare.bind(rawSqlite);
if(!timingOnly)rawSqlite.prepare=(sql)=>{
  const compileStart=performance.now();
  const stmt=prepare(sql);
  stats.prepareCalls++;stats.prepareMs+=performance.now()-compileStart;
  for(const method of ["all","get","run"]) {
    const original=stmt[method].bind(stmt);
    stmt[method]=(...params)=>{
      if(method==="run")throw Error("Offline profiling forbids writes");
      let rec=stats.queries.get(sql);
      if(!rec){rec={sql,calls:0,ms:0,rows:0,plan:null};stats.queries.set(sql,rec);}
      if(!rec.plan)rec.plan=()=>{try{return prepare("EXPLAIN QUERY PLAN "+sql).all(...params);}catch(e){return [{error:e.message}];}};
      const start=performance.now();
      try{const value=original(...params);rec.rows+=Array.isArray(value)?value.length:value?1:0;return value;}
      finally{rec.calls++;rec.ms+=performance.now()-start;}
    };
  } return stmt;
};
globalThis.__buyingDb=rawSqlite;
`;
const entry = `
import express from "express";
import http from "node:http";
import {writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {registerConsoleLeaderboardRoutes} from ${JSON.stringify(sourceFile)};
const RealDate=Date, stamp=Date.parse(${JSON.stringify(date)});
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}};
globalThis.fetch=async()=>{throw Error("Offline profiling forbids outbound fetch");};
const messages=[];console.log=(...args)=>messages.push(args.join(" "));console.error=console.log;
const app=express();
// Exercise the operator read path, avoiding a synthetic160-request matrix
// hitting the unrelated public120/min limiter.
app.use((req,_res,next)=>{req.saberUser={offlineProfile:true};next();});
registerConsoleLeaderboardRoutes(app);
const server=app.listen(0,"127.0.0.1");
await new Promise(resolve=>server.once("listening",resolve));
const port=server.address().port;
const paths=${JSON.stringify(option("--path") ? [option("--path")] : [])};
const navigation=${args.includes("--navigation")};
if(navigation)paths.push(...["steam","ps5","xbox"].map(p=>"/api/console/leaderboards/"+p+"?window=d7"),
 "/api/console/leaderboards-multiplatform?window=d7&limit=40");
if(!paths.length)for(const window of ["d7","d30","d90","m12","ltd"]){
 for(const platform of ["steam","ps5","xbox"]){
  const sorts=${args.includes("--full") ? '["revenue","units","ratings","score","asp"]' : '["revenue"]'};
  const dirs=${args.includes("--full") ? '["desc","asc"]' : '["desc"]'};
  for(const sort of sorts)for(const dir of dirs)paths.push("/api/console/leaderboards/"+platform+"?window="+window+"&sort="+sort+"&dir="+dir);
 }
 for(const limit of [20,40])paths.push("/api/console/leaderboards-multiplatform?window="+window+"&limit="+limit);
}
const report={date:${JSON.stringify(date)},source:${JSON.stringify(source)},sqlite:globalThis.__buyingDb.prepare("select sqlite_version() as version").get(),responses:[]};
if(navigation){
 const stats=globalThis.__buyingProfile;stats.udfCalls=0;stats.prepareCalls=0;stats.prepareMs=0;stats.queries.clear();
 // Separate client process is essential: measuring HTTP on the same blocked
 // Node loop would make all four responses appear to finish simultaneously.
 const clientCode=\`
 const http=require("node:http"),[port,raw]=process.argv.slice(1),paths=JSON.parse(raw),start=performance.now();
 Promise.all(paths.map(path=>new Promise((resolve,reject)=>{
  const began=performance.now();http.get({hostname:"127.0.0.1",port:Number(port),path},res=>{
   let body="";res.setEncoding("utf8");res.on("data",s=>body+=s);res.on("end",()=>resolve({
    path,status:res.statusCode,body,ms:performance.now()-began,completedMs:performance.now()-start}));
  }).on("error",reject);
 }))).then(responses=>process.stdout.write(JSON.stringify({responses,allCompleteMs:performance.now()-start})))
 .catch(e=>{console.error(e);process.exitCode=1});
 \`;
 const navigationResult=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,["-e",clientCode,String(port),JSON.stringify(paths)],{stdio:["ignore","pipe","inherit"]});
  let output="";child.stdout.on("data",s=>output+=s);child.on("error",reject);
  child.on("exit",code=>code?reject(Error("Navigation client failed")):resolve(JSON.parse(output)));
 });
 report.workload={kind:"four-normal-concurrent-buying-requests",allCompleteMs:navigationResult.allCompleteMs,
  udfCalls:stats.udfCalls,prepareCalls:stats.prepareCalls,prepareMs:stats.prepareMs,queryCalls:[...stats.queries.values()].reduce((n,q)=>n+q.calls,0),
  queries:[...stats.queries.values()].map(q=>({...q,plan:q.plan()})).sort((a,b)=>b.ms-a.ms)};
 for(const [index,response] of navigationResult.responses.entries()){
  const json=JSON.parse(response.body);
  writeFileSync(${JSON.stringify(out)}+"/"+index+".response.json",JSON.stringify(json,null,2));
  report.responses.push({...response,body:undefined,sha256:createHash("sha256").update(JSON.stringify(json)).digest("hex"),queries:[]});
  if(response.status!==200)throw Error("Offline navigation failed: "+response.body);
 }
}else for(const path of paths){
 const stats=globalThis.__buyingProfile;stats.udfCalls=0;stats.prepareCalls=0;stats.prepareMs=0;stats.queries.clear();
 const start=performance.now();
 const response=await new Promise((resolve,reject)=>{
  http.get({hostname:"127.0.0.1",port,path,headers:{"x-profile":"offline"}},res=>{
   let body="";res.setEncoding("utf8");res.on("data",chunk=>body+=chunk);res.on("end",()=>resolve({status:res.statusCode,body}));
  }).on("error",reject);
 });
 const ms=performance.now()-start;
 const json=JSON.parse(response.body), index=report.responses.length;
 writeFileSync(${JSON.stringify(out)}+"/"+index+".response.json",JSON.stringify(json,null,2));
 const queries=[...stats.queries.values()].map(q=>({...q,plan:q.plan()})).sort((a,b)=>b.ms-a.ms);
 const result={path,status:response.status,ms,udfCalls:stats.udfCalls,
  prepareCalls:stats.prepareCalls,prepareMs:stats.prepareMs,
  queryCalls:queries.reduce((n,q)=>n+q.calls,0),sqlMs:queries.reduce((n,q)=>n+q.ms,0),
  sha256:createHash("sha256").update(JSON.stringify(json)).digest("hex"),queries};
 report.responses.push(result);
 if(response.status!==200)throw Error("Offline route failed: "+response.body);
}
writeFileSync(${JSON.stringify(out+"/report.json")},JSON.stringify(report,null,2));
writeFileSync(${JSON.stringify(out+"/route-messages.txt")},messages.join("\\n"));
await new Promise(resolve=>server.close(resolve));globalThis.__buyingDb.close();
process.stdout.write(JSON.stringify({responses:report.responses.length,output:${JSON.stringify(out)}})+"\\n");
`;
await build({
  stdin: { contents: entry, resolveDir: source, sourcefile: "offline-buying-entry.ts", loader: "ts" },
  outfile: resolve(out, "runner.mjs"), bundle: true, platform: "node", format: "esm",
  packages: "external", nodePaths: [resolve(home, "node_modules")],
  tsconfig: resolve(source, "tsconfig.json"),
  plugins: [{
    name: "offline-readonly-seams",
    setup(b) {
      b.onResolve({ filter: /(^|\/)storage$/ }, args => {
        if (resolve(args.resolveDir, args.path) === resolve(source, "server/storage"))
          return { path: "offline-storage", namespace: "offline" };
      });
      b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ contents: storageShim, loader: "ts", resolveDir: source }));
      b.onLoad({ filter: /routes-console-leaderboards\.ts$/ }, args => {
        let contents = readFileSync(args.path, "utf8");
        const startup = /  ensureMixSchema\(rawSqlite\);\n  ensureDailyMixSchema\(rawSqlite\);\n  setImmediate\(\(\) => \{[\s\S]*?\n  \}\);/;
        if (!startup.test(contents)) throw Error("Startup writer seam changed; fail closed");
        contents = contents.replace(startup, "  // OFFLINE: no schema initialization or asynchronous model writers.");
        return { contents, loader: "ts", resolveDir: dirname(args.path) };
      });
      b.onLoad({ filter: /board-response-cache\.ts$/ }, () => ({
        contents: "export const boardResponseCache=()=> (_req,_res,next)=>next();",
        loader: "ts",
      }));
    },
  }],
});
// ESM external imports resolve beside the runner; link dependency location only.
const { symlinkSync } = await import("node:fs");
symlinkSync(resolve(home, "node_modules"), resolve(out, "node_modules"), "dir");
writeFileSync(resolve(out, "harness-policy.json"), JSON.stringify({
  source, db, date, readonly: true, queryOnly: true, outboundFetch: false,
  snapshotSha256: beforeHash, sourceRevision: manifest?.source_revision, modes,
  instrumentation: !args.includes("--timing-only"),
  changes: ["suppress startup schema/model writers", "bypass response cache", "freeze wall-clock for parity", "SQL/UDF instrumentation"],
  note: "EXPLAIN is captured after HTTP and SQL timers stop. Snapshot plans may differ from production physical layout. Name-only pure memoization stays enabled. Navigation mode uses a separate client process and exactly four concurrent requests.",
}, null, 2));
const run = spawnSync(process.execPath, [
  ...(args.includes("--cpu-profile") ? ["--cpu-prof","--cpu-prof-dir="+out] : []),
  resolve(out, "runner.mjs")], {
  env: { ...process.env, ...modes, NODE_ENV: "production", PROFILE_DB: db }, stdio: "inherit",
});
if (await fileHash(db) !== beforeHash) throw Error("Snapshot changed during read-only profile");
process.exit(run.status ?? 1);
