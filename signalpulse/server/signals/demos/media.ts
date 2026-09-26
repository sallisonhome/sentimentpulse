import { rawSqlite } from "../../storage";
import { directIgdbAvailable, fetchIgdbDetailBySteamAppid } from "../../igdb";
import { SABER_DEMO_ROSTER } from "./saber-seed";
import type { DemoMedia, DemoMediaResponse } from "../../../shared/demo-detail";

const inFlight=new Map<string,Promise<DemoMediaResponse>>();
const TTL=24*3600000;

/** Metadata fallback only. This identity never reaches a metrics query. */
export async function verifiedDemoParent(appId:string):Promise<string|null> {
  const roster=SABER_DEMO_ROSTER.find(d=>d.steamAppId===appId)?.parentSteamAppId;
  if(roster) return roster;
  const url=new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  const items=async(ids:string[])=>{
    url.searchParams.set("input_json",JSON.stringify({ids:ids.map(id=>({appid:Number(id)})),
      context:{language:"english",country_code:"US"},data_request:{include_basic_info:true}}));
    const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error("Steam metadata unavailable");
    const body=await response.json();
    if(!Array.isArray(body?.response?.store_items))throw Error("Steam metadata unavailable");
    return body.response.store_items as any[];
  };
  const demo=(await items([appId])).find(d=>String(d.id)===appId);
  if(demo?.success!==1||demo.type!==1)return null;
  const parent=demo.related_items?.parent_appid;
  if(!Number.isSafeInteger(parent)||parent<=0||String(parent)===appId)return null;
  const game=(await items([String(parent)])).find(d=>d.id===parent);
  return game?.success===1&&game.type===0 ? String(parent):null;
}

export function getDemoMedia(appId:string):Promise<DemoMediaResponse>{
  const existing=inFlight.get(appId); if(existing)return existing;
  const work=load(appId).finally(()=>inFlight.delete(appId));
  inFlight.set(appId,work);return work;
}
async function load(appId:string):Promise<DemoMediaResponse>{
  const cached=rawSqlite.prepare("SELECT * FROM demo_media_cache WHERE steam_app_id=?").get(appId) as any;
  const media:DemoMedia|null=cached?.payload ? JSON.parse(cached.payload):null;
  const response=(status:DemoMediaResponse["status"],value=media,fetchedAt=cached?.fetched_at??null):DemoMediaResponse=>
    ({media:value,fetchedAt,status,stale:!!value&&(status!=="matched"||Date.now()-Date.parse(fetchedAt)>TTL)});
  // Negative cache prevents repeated API calls for unlisted demos. Errors
  // retry after an hour; last-good media is retained and labeled stale.
  if(cached&&Date.now()-Date.parse(cached.last_attempt_at)<(cached.status==="unavailable"?3600000:TTL))
    return response(cached.status);
  const now=new Date().toISOString();
  try{
    if(!directIgdbAvailable())throw Error("IGDB not configured");
    let matchedAppId=appId,scope:"demo"|"parent"="demo";
    let match=await fetchIgdbDetailBySteamAppid(Number(appId));
    if(!match){
      const parent=await verifiedDemoParent(appId);
      if(parent){matchedAppId=parent;scope="parent";match=await fetchIgdbDetailBySteamAppid(Number(parent));}
    }
    const value=match ? {...match,matchedAppId,scope}:null;
    const status=value?"matched":"no_match";
    rawSqlite.prepare(`INSERT INTO demo_media_cache VALUES(?,?,?,?,?)
      ON CONFLICT(steam_app_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,
      last_attempt_at=excluded.last_attempt_at,status=excluded.status`).run(appId,value?JSON.stringify(value):null,now,now,status);
    return response(status,value,now);
  }catch{
    rawSqlite.prepare(`INSERT INTO demo_media_cache VALUES(?,NULL,NULL,?,'unavailable')
      ON CONFLICT(steam_app_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status`)
      .run(appId,now);
    return response("unavailable");
  }
}
