import type { Express } from "express";
import { rawSqlite } from "./storage";
import { loadDemoCatalog, loadArchivedDemoCatalog } from "./signals/demos/catalog";
import { archivedRow, archivedSnapshot } from "./signals/demos/archive";
import { loadDemoHistory } from "./signals/demos/history";
import { getDemoMedia } from "./signals/demos/media";
import { loadDemoDetailSummary } from "./routes-demos-leaderboard";
import { NON_SABER_DOWNLOAD_TRIAL } from "./signals/demos/download-consistency";
import type { DemoDetail, DemoRange } from "../shared/demo-detail";

export function registerDemoDetailRoutes(app: Express) {
  // Registered behind the same human-auth middleware as demo leaderboards.
  const title = (id:string) => /^[1-9]\d{0,9}$/.test(id)
    ? loadDemoCatalog("demo").find(t=>t.steam_app_id===id) : undefined;
  app.get("/api/demos/archive",(req,res)=>{
    const search=String(req.query.search??"").trim().toLowerCase(),genre=String(req.query.genre??"");
    const offset=Number(req.query.offset??0),limit=Number(req.query.limit??50);
    const sort=String(req.query.sort??"deactivated"),direction=String(req.query.direction??"desc");
    if(search.length>120||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>250||
      !["name","release","deactivated","downloads","reviews","peak"].includes(sort)||!["asc","desc"].includes(direction))
      return res.status(400).json({error:"Invalid archive filters"});
    try{
      const catalog=loadArchivedDemoCatalog();
      const genres=Array.from(new Set(catalog.flatMap(t=>t.genre?.split(", ")??[]))).sort();
      const rows=catalog.filter(t=>(!search||t.name.toLowerCase().includes(search)||t.steam_app_id===search)&&
        (!genre||(t.genre??"").split(", ").includes(genre))).map(archivedRow);
      const keys={name:"name",release:"releaseDate",deactivated:"deactivatedAt",downloads:"downloads",reviews:"reviews",peak:"peak"} as const;
      const key=keys[sort as keyof typeof keys];
      rows.sort((a,b)=>{
        const av=a[key],bv=b[key];
        if(av==null&&bv==null)return a.name.localeCompare(b.name);
        if(av==null)return 1;if(bv==null)return -1;
        const diff=typeof av==="number"?av-Number(bv):String(av).localeCompare(String(bv));
        return (direction==="asc"?diff:-diff)||a.name.localeCompare(b.name);
      });
      const resolved=rows.length?Math.min(offset,Math.floor((rows.length-1)/limit)*limit):0;
      res.set("Cache-Control","no-store").json({demos:rows.slice(resolved,resolved+limit),genres,total:rows.length,
        offset:resolved,limit,hasMore:resolved+limit<rows.length});
    }catch{res.status(500).json({error:"Archived demo history unavailable"});}
  });
  app.get("/api/demos/titles/:appId", (req,res)=>{
    const t=title(String(req.params.appId));
    if(!t)return res.status(404).json({error:"Tracked demo not found. Friends Passes are excluded."});
    const range=String(req.query.days??"30") as DemoRange;
    if(!["7","30","90","365","all"].includes(range))return res.status(400).json({error:"Invalid history range"});
    try{
      const saber=t.is_saber_published===1, archived=t.is_active!==1;
      const snapshot=archived?archivedSnapshot(t):null;
      const summary=loadDemoDetailSummary(t.steam_app_id);
      const timestamps=rawSqlite.prepare("SELECT first_seen_at,last_checked_at,deactivated_at FROM demo_titles WHERE id=?").get(t.id) as any;
      const latestWindows:DemoDetail["latestWindows"]=saber
        ? (rawSqlite.prepare(`SELECT window,downloads,fetched_at AS asOf,source FROM demo_download_actuals
            WHERE steam_app_id=? AND source='steamworks_downloads_report'`).all(t.steam_app_id) as any[])
        : (rawSqlite.prepare(`SELECT e.window,e.units_mid AS downloads,e.as_of_date AS asOf,e.multiplier_id AS source
            FROM demo_window_estimates_daily e WHERE demo_title_id=? AND method='review_delta_multiplier'
            AND e.as_of_date=(SELECT MAX(n.as_of_date) FROM demo_window_estimates_daily n
              WHERE n.demo_title_id=e.demo_title_id AND n.window=e.window AND n.method='review_delta_multiplier')`).all(t.id) as any[]);
      const data:DemoDetail={appId:t.steam_app_id,name:t.name,isSaber:saber,archived,genre:t.genre,releaseDate:t.release_date,
        firstSeenAt:timestamps.first_seen_at,lastCheckedAt:timestamps.last_checked_at,range,
        deactivatedAt:timestamps.deactivated_at??null,snapshotAsOf:snapshot?.snapshotAsOf??null,
        multiplier:saber?null:NON_SABER_DOWNLOAD_TRIAL,...loadDemoHistory(rawSqlite,t,range),
        latest:{downloads:summary!.unitsMid,observedMinimum:summary!.isObservedMinimum,
          reviews:summary!.reviewCountTotal,positivePercent:summary!.steamReviews?.positivePercent??null,
          ccu:summary!.ccuCurrent,peak:summary!.ccuAllTimePeak,ccuObservedAt:summary!.ccuAsOf,
          actualsAsOf:summary!.actualsAsOf,actualsStale:summary!.actualsStale,actualsRefreshFailed:summary!.actualsRefreshFailed},
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
