/** Isolated local QA only: no production bootstrap, keys, schedulers or ingestion.
 * Saved scenario observations are real public research inputs; catalog names
 * below are a minimal QA roster with intentionally missing measured metrics.
 */
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,"..");
const isolated=mkdtempSync(path.join(tmpdir(),"qualified-pass-preview-"));
process.chdir(isolated);
const {rawSqlite}=await import("../server/storage");
const {upsertDiscoveredDemo}=await import("../server/signals/demos/discovery");
for(const [steamAppId,name] of [
  ["3664720","Lords of the Fallen - Free Friend’s Pass"],
  ["2995920","It Takes Two Friend’s Pass"],
  ["3052150","Split Fiction Friend’s Pass"],
]) upsertDiscoveredDemo({steamAppId,name,genre:"Adventure",releaseDate:null,
  skuKind:"friends_pass",discoveredVia:"manual"});
const app=express(), router=express();
// Only this isolated QA process accepts preview-origin reads.
app.use((req,res,next)=>{
  if(req.headers.origin)res.setHeader("Access-Control-Allow-Origin",req.headers.origin);
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Credentials","true");
  if(req.method==="OPTIONS"){res.sendStatus(204);return;}
  next();
});
const {registerDemosLeaderboardRoutes}=await import("../server/routes-demos-leaderboard");
registerDemosLeaderboardRoutes(router);
router.get("/api/config",(_req,res)=>res.json({authMode:"legacy",authReady:false,meUrl:"/auth/api/me"}));
router.get("/api/products",(_req,res)=>res.json([]));
router.get("/api/steam/session-status",(_req,res)=>res.json({}));
router.get("/api/qa-integrity",(_req,res)=>res.json({
  integrity:rawSqlite.pragma("integrity_check",{simple:true}),
  actuals:(rawSqlite.prepare("SELECT count(*) n FROM demo_download_actuals").get() as any).n,
  snapshots:(rawSqlite.prepare("SELECT count(*) n FROM demo_ccu_snapshots").get() as any).n,
  isolated:true,schedulersStarted:false,
}));
app.get("/auth/api/me",(_req,res)=>res.status(401).json({user:null}));
app.get("/api/inbound/unread-count",(_req,res)=>res.json({unread:0}));
router.use(express.static(path.join(root,"dist/public")));
app.use("/signal",router);
app.get("/",(_req,res)=>res.redirect("/signal/#/demos-leaderboard"));
app.listen(5227,"0.0.0.0",()=>console.log("Isolated DemoPulse QA: http://127.0.0.1:5227/signal/#/demos-leaderboard"));
