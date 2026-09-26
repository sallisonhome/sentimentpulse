import type { Express } from "express";
import { rawSqlite } from "./storage";
import { loadDemoCatalog } from "./signals/demos/catalog";
import { loadDemoHistory } from "./signals/demos/history";
import { getDemoMedia } from "./signals/demos/media";
import { loadDemoDetailSummary } from "./routes-demos-leaderboard";
import { NON_SABER_DOWNLOAD_TRIAL } from "./signals/demos/download-consistency";
import type { DemoDetail, DemoRange } from "../shared/demo-detail";

export function registerDemoDetailRoutes(app: Express) {
  // Registered behind the same human-auth middleware as demo leaderboards.
  const title = (id:string) => /^[1-9]\d{0,9}$/.test(id)
    ? loadDemoCatalog("demo").find(t=>t.steam_app_id===id) : undefined;
  app.get("/api/demos/titles/:appId", (req,res)=>{
    const t=title(String(req.params.appId));
    if(!t)return res.status(404).json({error:"Tracked demo not found. Deactivated non-Saber demos and Friends Passes are excluded."});
    const range=String(req.query.days??"30") as DemoRange;
    if(!["7","30","90","365","all"].includes(range))return res.status(400).json({error:"Invalid history range"});
    try{
      const summary=loadDemoDetailSummary(t.steam_app_id)!;
      const timestamps=rawSqlite.prepare("SELECT first_seen_at,last_checked_at FROM demo_titles WHERE id=?").get(t.id) as any;
      const saber=t.is_saber_published===1, archived=t.is_active!==1;
      const latestWindows:DemoDetail["latestWindows"]=saber
        ? (rawSqlite.prepare(`SELECT window,downloads,fetched_at AS asOf,source FROM demo_download_actuals
            WHERE steam_app_id=? AND source='steamworks_downloads_report' ${archived?"AND window='ltd'":""}`).all(t.steam_app_id) as any[])
        : (rawSqlite.prepare(`SELECT e.window,e.units_mid AS downloads,e.as_of_date AS asOf,e.multiplier_id AS source
            FROM demo_window_estimates_daily e WHERE demo_title_id=? AND method='review_delta_multiplier'
            AND e.as_of_date=(SELECT MAX(n.as_of_date) FROM demo_window_estimates_daily n
              WHERE n.demo_title_id=e.demo_title_id AND n.window=e.window AND n.method='review_delta_multiplier')`).all(t.id) as any[]);
      const data:DemoDetail={appId:t.steam_app_id,name:t.name,isSaber:saber,archived,genre:t.genre,releaseDate:t.release_date,
        firstSeenAt:timestamps.first_seen_at,lastCheckedAt:timestamps.last_checked_at,range,
        multiplier:saber?null:NON_SABER_DOWNLOAD_TRIAL,...loadDemoHistory(rawSqlite,t,range),
        latest:{downloads:summary.unitsMid,observedMinimum:summary.isObservedMinimum,
          reviews:archived?null:summary.reviewCountTotal,positivePercent:summary.steamReviews?.positivePercent??null,
          ccu:summary.ccuCurrent,peak:summary.ccuAllTimePeak,ccuObservedAt:summary.ccuAsOf,
          actualsAsOf:summary.actualsAsOf,actualsStale:summary.actualsStale,actualsRefreshFailed:summary.actualsRefreshFailed},
        latestWindows:latestWindows.sort((a,b)=>["d7","d30","d90","m12","ltd"].indexOf(a.window)-["d7","d30","d90","m12","ltd"].indexOf(b.window))};
      res.set("Cache-Control","no-store").json(data);
    }catch{res.status(500).json({error:"Demo history unavailable. Please retry."});}
  });
  app.get("/api/demos/titles/:appId/media", async(req,res)=>{
    const t=title(String(req.params.appId));
    if(!t)return res.status(404).json({error:"Tracked demo not found"});
    try{res.set("Cache-Control","no-store").json(await getDemoMedia(t.steam_app_id));}
    catch{res.status(503).json({error:"Demo media unavailable"});}
  });
}
