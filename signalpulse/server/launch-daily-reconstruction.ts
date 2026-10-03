import type Database from "better-sqlite3";
import { reviewWindow, type ReviewBucket } from "./steam-review-windows";

export const LAUNCH_DAILY_VERSION = "review_activity_launch_allocation_v1";
const DAY = 86400000;
const WINDOWS: Record<string, number | null> = {d7:7,d30:30,d90:90,m12:365,ltd:null};
// Reviewed recovery scope, NOT a sales anchor or a fixed unit/revenue target.
// Native identities and early-access boundary are deliberately explicit.
type Scope = {
  key:string; steamId:number; appId:string; ps5Id:number; ps5Sku:string;
  xboxId?:number; xboxSku?:string; start:string; source:string;
  // Console SKUs may carry edition rows (Deluxe); only base rows enter the checks.
  ignoreEditions?:boolean;
  // Console lines allocate each console's OWN native estimate (never Steam times a ratio).
  nativeConsole?:boolean;
};
const SCOPES:Scope[] = [{
  key:"silent hill: townfall", steamId:10175, appId:"1636440",
  ps5Id:10774, ps5Sku:"JP0101-PPSA33286_00-TOWNFALLSIEJ0000",
  start:"2026-09-22",
  source:"https://www.konami.com/games/eu/en/topics/19323/",
},{
  // Minecraft Dungeons II (Xbox Game Studios, Game Pass day one), released 2026-09-29.
  // Xbox rows are the reviewed PS5-price-matched SKUs (PR 195). Console lines carry each
  // platform's native estimate spread over the launch days by Steam review activity.
  key:"minecraft dungeons ii", steamId:10102, appId:"1912410",
  ps5Id:10969, ps5Sku:"EP4433-PPSA16064_00-SWPS500000000000",
  xboxId:11293, xboxSku:"9P5786PJB9RP", ignoreEditions:true, nativeConsole:true,
  start:"2026-09-29",
  source:"https://store.steampowered.com/app/1912410/",
}];
const ms = (date:string) => Date.parse(date+"T00:00:00Z");
const iso = (n:number) => new Date(n).toISOString().slice(0,10);
const validDate = (date:string) => Number.isFinite(ms(date)) && iso(ms(date))===date;
type Day = {date:string; signal:number};
type WindowTarget = {start:string; units:number};

/** Nested-window constrained allocation. Each disjoint band conserves its
 * published revenue-derived units; rounding never creates an extra sale.
 * Targets are recomputed from current evidence, never frozen to an old total. */
export function allocateNestedDays(days:Day[],targets:WindowTarget[]) {
  const bands=[...targets].sort((a,b)=>b.start.localeCompare(a.start));
  const out=new Map<string,number>();
  let priorStart="9999-12-31",priorUnits=0;
  for(const b of bands) {
    const band=days.filter(d=>d.date>=b.start&&d.date<priorStart);
    const units=b.units-priorUnits,signal=band.reduce((s,d)=>s+d.signal,0);
    if(!Number.isSafeInteger(units)||units<0||(!signal&&units))return null;
    const shares=band.map(d=>({...d,exact:signal?d.signal*units/signal:0}));
    let left=units-shares.reduce((s,d)=>s+Math.floor(d.exact),0);
    const extra=new Set([...shares].sort((a,b)=>(b.exact%1)-(a.exact%1)||a.date.localeCompare(b.date))
      .slice(0,left).map(d=>d.date));
    for(const d of shares)out.set(d.date,Math.floor(d.exact)+(extra.has(d.date)?1:0));
    priorStart=b.start;priorUnits=b.units;
  }
  return out;
}

export function reconstructLaunchDaily(
  db:Database.Database, key:string|null, from:string, to:string,
  economics:{steamFactor:number; ps5Factor:number; ps5Ratio:number; xboxFactor?:number; xboxRatio?:number},
) {
  const SCOPE=SCOPES.find(s=>s.key===key);
  if(!SCOPE||process.env.LAUNCH_DAILY_RECONSTRUCTION_ENABLED==="0")return null;
  if((db.prepare("SELECT value FROM app_settings WHERE key='launch_daily_reconstruction_enabled'").get() as any)?.value==="0")return null;
  if(!validDate(from)||!validDate(to)||from>to||ms(to)-ms(from)>3660*DAY)return null;
  const {steamFactor,ps5Factor,ps5Ratio,xboxFactor,xboxRatio}=economics;
  const xbox=SCOPE.xboxId!=null;
  const ids=[SCOPE.steamId,SCOPE.ps5Id,...(xbox?[SCOPE.xboxId!]:[])];
  const marks=ids.map(()=>"?").join(",");
  const allMaps=db.prepare(`SELECT * FROM platform_sku_map
    WHERE title_id IN (${marks}) OR (platform='steam' AND external_sku=?)`).all(...ids,SCOPE.appId) as any[];
  const maps=SCOPE.ignoreEditions?allMaps.filter(r=>r.sku_role!=="edition"):allMaps;
  // Reviewed Xbox SKUs are manual overrides by design; every other row must not be.
  const reviewedXbox=(r:any)=>r.platform==="xbox"&&String(r.business_model_source??"").startsWith("xbox_reviewed_");
  if(!maps.length||maps.some(r=>r.sku_role!=="base"||r.business_model!=="paid"||(r.is_manual_override&&!reviewedXbox(r))||r.is_gamepass))return null;
  if(maps.some(r=>r.platform==="steam"?(r.title_id!==SCOPE.steamId||r.external_sku!==SCOPE.appId):
    r.platform==="ps5"?r.title_id!==SCOPE.ps5Id:
    !(xbox&&r.platform==="xbox"&&r.title_id===SCOPE.xboxId)))return null;
  if(!maps.some(r=>r.platform==="steam")||!maps.some(r=>r.external_sku===SCOPE.ps5Sku))return null;
  if(xbox&&!maps.some(r=>r.platform==="xbox"&&r.external_sku===SCOPE.xboxSku))return null;
  const price=(p:string)=>Math.min(...maps.filter(r=>r.platform===p).map(r=>r.msrp_usd_cents??NaN))/100;
  const steamAsp=price("steam")*steamFactor,ps5Asp=price("ps5")*ps5Factor;
  const xboxAsp=xbox?price("xbox")*(xboxFactor??NaN):0;
  const native=!!SCOPE.nativeConsole;
  if(![steamAsp,ps5Asp,...(native?[]:[ps5Ratio]),...(xbox?[xboxAsp,...(native?[]:[xboxRatio??NaN])]:[1])].every(n=>Number.isFinite(n)&&n>0))return null;
  if(db.prepare(`SELECT 1 FROM revenue_calibration_anchors WHERE title_id IN (${marks}) LIMIT 1`).get(...ids)||
     db.prepare(`SELECT 1 FROM title_multiplier_overrides WHERE title_id IN (${marks}) LIMIT 1`).get(...ids)||
     db.prepare(`SELECT 1 FROM steam_unit_milestones WHERE title_id IN (${marks}) AND active=1 LIMIT 1`).get(...ids))return null;
  if(db.prepare(`SELECT 1 FROM revenue_mix_daily WHERE family_key=? AND applied=1 LIMIT 1`).get(key))return null;
  const latest=db.prepare(`SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam' AND window='ltd'
    ORDER BY as_of_date DESC LIMIT 1`).get(SCOPE.steamId) as any;
  if(!latest||latest.gated_reason||!validDate(latest.as_of_date)||latest.as_of_date<SCOPE.start)return null;
  const snapshot=db.prepare(`SELECT * FROM store_rating_signal_daily WHERE title_id=? AND platform='steam'
    AND capture_date=?`).get(SCOPE.steamId,latest.as_of_date) as any;
  if(!snapshot||snapshot.rating_count!==latest.signal_value)return null;
  const multiplier=db.prepare("SELECT * FROM ownership_multipliers WHERE id=?").get(latest.multiplier_id) as any;
  if(!multiplier||multiplier.platform!=="steam"||!(multiplier.multiplier>0)||!(multiplier.digital_unit_share>0))return null;
  const coefficient=multiplier.multiplier/multiplier.digital_unit_share;
  const buckets=db.prepare("SELECT * FROM steam_review_history WHERE app_id=?").all(SCOPE.appId) as ReviewBucket[];
  const end=latest.as_of_date;
  const daily=buckets.filter(b=>b.bucket_granularity==="day"&&b.bucket_start<=ms(end)/1000);
  if(daily.some(b=>b.bucket_start<ms(SCOPE.start)/1000||b.bucket_start%86400!==0||
    !Number.isSafeInteger(b.recommendations_up)||b.recommendations_up<0||
    !Number.isSafeInteger(b.recommendations_down)||b.recommendations_down<0))return null;
  const days=daily.map(b=>({date:iso(b.bucket_start*1000),signal:b.recommendations_up+b.recommendations_down})).sort((a,b)=>a.date.localeCompare(b.date));
  if(days.length!==(ms(end)-ms(SCOPE.start))/DAY+1||
    days.some((d,i)=>ms(d.date)!==ms(SCOPE.start)+i*DAY))return null;
  const total=days.reduce((s,d)=>s+d.signal,0);
  if(total!==snapshot.rating_count||reviewWindow(buckets,end,null).signal!==total)return null;
  const targets=new Map<string,number>(),ps5Targets=new Map<string,number>(),xboxTargets=new Map<string,number>();
  for(const [window,n] of Object.entries(WINDOWS)) {
    const start=n==null?SCOPE.start:iso(Math.max(ms(SCOPE.start),ms(end)-(n-1)*DAY));
    const signal=days.filter(d=>d.date>=start).reduce((s,d)=>s+d.signal,0);
    const units=Math.round(signal*coefficient);
    const saved=db.prepare(`SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam'
      AND window=? AND as_of_date=?`).get(SCOPE.steamId,window,end) as any;
    // A stale/gated/protected estimator is not silently "fixed" by a chart.
    // The existing writer must first admit the new evidence to shared totals.
    if(!saved||saved.gated_reason||saved.signal_value!==signal||saved.units_mid!==units||
      saved.multiplier_id!==latest.multiplier_id||!String(saved.method).startsWith("calibrated_from_actuals"))return null;
    const consoleRow=(id:number,platform:string)=>db.prepare(`SELECT * FROM window_estimates_daily WHERE title_id=? AND platform=?
      AND window=? ORDER BY as_of_date DESC LIMIT 1`).get(id,platform,window) as any;
    const consoleOk=(c:any)=>!!c&&!c.gated_reason&&c.units_mid!=null&&c.as_of_date===end;
    const ps5Row=consoleRow(SCOPE.ps5Id,"ps5"),xboxRow=xbox?consoleRow(SCOPE.xboxId!,"xbox"):null;
    if(!consoleOk(ps5Row)||(xbox&&!consoleOk(xboxRow))||
      units*steamAsp<=1000)return null; // match public overlay's meaningful-Steam gate
    targets.set(start,units);
    ps5Targets.set(start,native?Math.round(ps5Row.units_mid):Math.round(units*steamAsp*ps5Ratio/ps5Asp));
    if(xbox)xboxTargets.set(start,native?Math.round(xboxRow.units_mid):Math.round(units*steamAsp*xboxRatio!/xboxAsp));
  }
  const steamUnits=allocateNestedDays(days,Array.from(targets,([start,units])=>({start,units})));
  const consoleWeights=days.map(d=>({...d,signal:steamUnits?.get(d.date)??0}));
  const ps5Units=allocateNestedDays(consoleWeights,Array.from(ps5Targets,([start,units])=>({start,units})));
  const xboxUnits=xbox?allocateNestedDays(consoleWeights,Array.from(xboxTargets,([start,units])=>({start,units}))):null;
  if(!steamUnits||!ps5Units||(xbox&&!xboxUnits))return null;
  const points=[];
  for(let n=ms(from);n<=Math.min(ms(to),ms(end));n+=DAY) {
    const date=iso(n),units=steamUnits.get(date);
    if(units==null) {
      points.push({date,steam:null,ps5:null,xbox:null,combined:null,units:null,source:"unavailable"});
      continue;
    }
    const steam=units*steamAsp,xu=xbox?xboxUnits!.get(date)!:null;
    const ps5=native?ps5Units.get(date)!*ps5Asp:steam*ps5Ratio,xr=xbox?(native?xu!*xboxAsp:steam*xboxRatio!):null;
    points.push({date,steam,ps5,xbox:xr,combined:steam+ps5+(xr??0),
      units:{steam:units,ps5:ps5Units.get(date)!,xbox:xu,combined:units+ps5Units.get(date)!+(xu??0)},
      source:LAUNCH_DAILY_VERSION,
      basis:{steam:"review_activity_model",ps5:"modeled_platform_allocation",...(xbox?{xbox:"modeled_platform_allocation"}:{})},
      reviewSignal:days.find(d=>d.date===date)!.signal});
  }
  return {from,to,collectionStart:SCOPE.start,asOfDate:end,estimateCreatedAt:latest.created_at,
    sourceUrl:SCOPE.source,points,version:LAUNCH_DAILY_VERSION,
    methodology:`Reconstructed daily sales estimates from Steam review activity, including early access. ${xbox?"PS5 and Xbox timing are modeled allocations":"PS5 timing is a modeled allocation"} ${SCOPE.nativeConsole?"from each console's own lifetime estimate":"using the same platform share as the leaderboards"}, not observed daily ${xbox?"PS5 or Xbox":"PS5"} sales. Revenue-derived units are rounded within period bands to reconcile with published totals. Newly admitted evidence can increase totals; missing days are not additional sales by themselves.`};
}
