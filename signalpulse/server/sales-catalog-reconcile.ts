import type Database from "better-sqlite3";
import { identityName } from "./console-title-identity";
import { editionGroupKey } from "./console-sales-family";
import { isVerifiedRatingsOnly, RATINGS_ONLY_SOURCES } from "./ratings-only-sku";
import { fetchSaleEvidence, type SaleEvidence, type SalesPlatform } from "./sales-catalog-eligibility";
import { SteamCatalogDeferred } from "./steam-catalog-cooldown";

export type CatalogRow = {
  id:number; title_id:number; platform:SalesPlatform; external_sku:string; concept_id:string|null;
  sku_role:string; business_model:string; msrp_usd_cents:number|null;
  business_model_source:string; is_manual_override:number; name:string|null;
  steam_app_id?:string|null; steam_name?:string|null; [key:string]:unknown;
};
export type CoverageDecision = {
  before:CatalogRow; status:"promote"|"covered"|"hold"|"error"|"deferred"; reason:string;
  evidence?:SaleEvidence; coveredBy?:number[]; after?:CatalogRow;
  metadataRecovery?:{before:Record<string,any>|null;after:Record<string,any>};
};
export function loadSalesCatalog(db:Database.Database):CatalogRow[] {
  const hasLinks=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verified_rating_links'").get();
  const rows = db.prepare(`SELECT p.*,COALESCE(x.name,NULLIF(i.store_name,''),i.name) AS name
    ${hasLinks?",l.steam_app_id,COALESCE(si.store_name,si.name) AS steam_name":""}
    FROM platform_sku_map p
    LEFT JOIN console_title_igdb i ON i.title_id=p.title_id
    LEFT JOIN xbox_title_cache x ON p.platform='xbox' AND x.big_id=p.external_sku
    ${hasLinks?`LEFT JOIN verified_rating_links l ON l.platform=p.platform AND l.external_sku=p.external_sku
      LEFT JOIN platform_sku_map sp ON sp.platform='steam' AND sp.external_sku=l.steam_app_id
      LEFT JOIN console_title_igdb si ON si.title_id=sp.title_id`:""}
    ORDER BY p.platform,p.title_id,p.id`).all() as CatalogRow[];
  if(hasLinks){
    const known=new Set(rows.filter(r=>r.platform==="steam").map(r=>r.external_sku));
    const links=db.prepare("SELECT * FROM verified_rating_links ORDER BY steam_app_id,platform,external_sku").all() as any[];
    for(const l of links){
      if(known.has(l.steam_app_id) || !/^[1-9]\d*$/.test(l.steam_app_id??"") ||
        !RATINGS_ONLY_SOURCES.includes(l.verification_source) || !l.store_name)continue;
      known.add(l.steam_app_id);
      rows.push({id:-rows.length-1,title_id:0,platform:"steam",external_sku:l.steam_app_id,
        concept_id:null,sku_role:"ratings_only",business_model:"unknown",msrp_usd_cents:null,
        business_model_source:l.verification_source,is_manual_override:1,name:l.store_name,
        is_new:true});
    }
  }
  return rows;
}
function pending(row:CatalogRow){
  return isVerifiedRatingsOnly(row) ||
    (row.sku_role==="base" && row.business_model==="unknown" && row.is_manual_override===0);
}
function unnamedSteam(row:CatalogRow){
  return row.platform==="steam" && row.title_id>0 && /^[1-9]\d*$/.test(row.external_sku) &&
    !row.name?.trim() && row.sku_role==="base" && row.business_model==="unknown" && row.is_manual_override===0;
}
function identityAgrees(row:CatalogRow,e:SaleEvidence){
  return e.platform===row.platform && e.sku===row.external_sku && !!e.name.trim() &&
    (unnamedSteam(row) ? e.verifiedAppId===row.external_sku :
      identityName(e.name)===identityName(row.name??"") ||
      (row.is_new && editionGroupKey(e.name)===editionGroupKey(row.name)));
}
/** Same-platform regional/edition identities are alternative observations,
 * not incremental sales. Also block duplicate title IDs and shared PS concepts. */
export function coveredBy(row:CatalogRow,catalog:CatalogRow[]):number[] {
  const matches=catalog.filter(p=>p.id!==row.id && p.platform===row.platform &&
    p.sku_role==="base" && p.business_model==="paid" && (
      (row.title_id>0 && p.title_id===row.title_id) ||
      (row.platform==="ps5" && row.concept_id && p.concept_id===row.concept_id) ||
      (!!row.name && !!p.name && (
        editionGroupKey(row.name)===editionGroupKey(p.name) ||
        identityName(row.name)===identityName(p.name))) ||
      (!!row.steam_app_id && row.steam_app_id===p.steam_app_id)
    ));
  return Array.from(new Set(matches.map(p=>p.title_id)));
}
export async function planSalesCoverage(
  catalog:CatalogRow[],
  verify:(platform:SalesPlatform,sku:string,name:string)=>Promise<SaleEvidence>=fetchSaleEvidence,
  options:{deadlineMs?:number;rotationOffset?:number}={},
):Promise<CoverageDecision[]> {
  const projected=catalog.map(p=>({...p}));
  const decisions:CoverageDecision[]=[];
  const eligibleCandidates=catalog.filter(p=>p.sku_role==="ratings_only" ||
    (p.sku_role==="base"&&p.business_model==="unknown"))
    .sort((a,b)=>Number(b.platform==="steam")-Number(a.platform==="steam")||a.id-b.id);
  const rotate=(rows:CatalogRow[])=>{
    const offset=rows.length?Math.abs(options.rotationOffset??0)%rows.length:0;
    return rows.slice(offset).concat(rows.slice(0,offset));
  };
  // Steam first, but rotate each cohort's verification order daily so source
  // timeouts cannot permanently starve the same tail of the catalog.
  const candidates=rotate(eligibleCandidates.filter(p=>p.platform==="steam"))
    .concat(rotate(eligibleCandidates.filter(p=>p.platform!=="steam")));
  for(const original of candidates){
    const before={...original};
    const d:CoverageDecision={before,status:"hold",reason:"unverified_ratings_mapping"};
    decisions.push(d);
    if(!pending(before) || (!before.name?.trim() && !unnamedSteam(before)))continue;
    const covered=coveredBy(before,projected);
    if(covered.length){d.status="covered";d.reason="existing_sales_family";d.coveredBy=covered;continue;}
    // A ratings-version alias alone does not authorize combining commercial
    // editions. Hold until the sales-family identity is explicitly resolved.
    const steamName=before.steam_name ??
      projected.find(p=>p.platform==="steam"&&p.external_sku===before.steam_app_id)?.name;
    if(steamName && editionGroupKey(steamName)!==editionGroupKey(before.name)){
      d.reason="sales_family_identity_requires_review";continue;
    }
    if(Date.now()>=(options.deadlineMs??Infinity)){
      d.status="deferred";d.reason="verification_budget_deferred";continue;
    }
    try{
      let e=await verify(before.platform,before.external_sku,before.name??"");
      // New Steam IDs come only from pre-verified exact storefront links.
      // A reviewed console-version name may differ, but its sales-family key
      // must match. Native product type, price and release still must pass.
      if(before.is_new && e.reason==="identity_mismatch" && e.released && e.msrpUsdCents!>0 &&
        editionGroupKey(e.name)===editionGroupKey(before.name)){
        e={...e,eligible:true,reason:"verified_paid_base"};
      }
      d.evidence=e;
      if(!identityAgrees(before,e)){
        d.reason="identity_mismatch";continue;
      }
      if(!e.eligible || !e.released || !(e.msrpUsdCents!>0)){d.reason=e.reason;continue;}
      const recoveredCovered=coveredBy({...before,name:e.name},projected);
      if(recoveredCovered.length){
        d.status="covered";d.reason="existing_sales_family";d.coveredBy=recoveredCovered;continue;
      }
      if(before.platform==="ps5" && before.concept_id && e.conceptId!==before.concept_id){
        d.reason="ps_concept_mismatch";continue;
      }
      d.status="promote";d.reason="verified_missing_paid_platform";
      const p=projected.find(p=>p.id===before.id)!;
      Object.assign(p,{name:e.name,sku_role:"base",business_model:"paid",msrp_usd_cents:e.msrpUsdCents});
    }catch(error){d.status=error instanceof SteamCatalogDeferred?"deferred":"error";d.reason=error instanceof Error?error.message:String(error);}
  }
  return decisions;
}
export const COVERAGE_SOURCE="verified_paid_base:daily_coverage_v1";
/** All accepted changes commit together. Every decision is revalidated under
 * BEGIN IMMEDIATE, so a second invocation cannot race a duplicate into sales.
 * No title IDs, snapshots, anchors, multipliers or lifetime state are edited. */
export function applySalesCoverage(db:Database.Database,decisions:CoverageDecision[],now=new Date()) {
  const proposed=decisions.filter(d=>d.status==="promote");
  const applied:CoverageDecision[]=[];
  db.transaction(()=>{
    const catalog=loadSalesCatalog(db);
    for(const d of proposed){
      let row=catalog.find(r=>r.id===d.before.id);
      const e=d.evidence!;
      if(d.before.is_new){
        // Temporary plan IDs are not persistent. Re-locate by the exact
        // verified Steam App ID after reloading the catalog in this transaction.
        row=catalog.find(r=>r.is_new && r.platform==="steam" && r.external_sku===d.before.external_sku);
      }
      if(!row || row.title_id!==d.before.title_id || row.platform!==d.before.platform ||
        row.external_sku!==d.before.external_sku || !pending(row) ||
        row.business_model!==d.before.business_model || row.msrp_usd_cents!==d.before.msrp_usd_cents ||
        row.business_model_source!==d.before.business_model_source ||
        row.concept_id!==d.before.concept_id || row.is_manual_override!==d.before.is_manual_override ||
        row.name!==d.before.name) throw Error(`Catalog changed during verification: ${d.before.id}`);
      if(coveredBy({...row,name:e.name},catalog).length)throw Error(`Concurrent family coverage detected: ${row.id}`);
      const age=now.getTime()-Date.parse(e.checkedAt);
      if(!e.eligible || !identityAgrees(row,e) ||
        (row.platform==="ps5" && row.concept_id && e.conceptId!==row.concept_id) ||
        !Number.isFinite(age) || age<0 || age>86400_000 ||
        !Number.isSafeInteger(e.msrpUsdCents) || e.msrpUsdCents!<=0 ||
        !e.released || e.released>now.toISOString().slice(0,10))throw Error("Invalid/stale sale evidence");
      let metadataRecovery:CoverageDecision["metadataRecovery"];
      if(unnamedSteam(row)){
        const before=db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(row.title_id) as Record<string,any>|undefined;
        db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(title_id) DO UPDATE SET
          name=CASE WHEN NULLIF(TRIM(console_title_igdb.name),'') IS NULL THEN excluded.name ELSE console_title_igdb.name END,
          store_name=excluded.store_name,store_release_date=excluded.store_release_date,refreshed_at=excluded.refreshed_at`)
          .run(row.title_id,e.name,e.name,e.released,now.toISOString(),now.toISOString());
        metadataRecovery={before:before??null,after:db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(row.title_id) as Record<string,any>};
      }
      if(row.is_new){
        const title=(db.prepare(`SELECT MAX(9999,COALESCE((SELECT MAX(title_id) FROM platform_sku_map),0),
          COALESCE((SELECT MAX(title_id) FROM console_title_igdb),0))+1 AS id`).get() as {id:number}).id;
        const insert=db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,
          business_model,msrp_usd_cents,business_model_source,is_manual_override,refreshed_at,created_at)
          VALUES(?,'steam',?,'base','paid',?,?,1,?,?)`).run(title,row.external_sku,e.msrpUsdCents,COVERAGE_SOURCE,now.toISOString(),now.toISOString());
        db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
          VALUES(?,?,?,?,?,?)`).run(title,e.name,e.name,e.released,now.toISOString(),now.toISOString());
        Object.assign(row,{id:Number(insert.lastInsertRowid),title_id:title,name:e.name,is_new:false});
      }else{
      const change=db.prepare(`UPDATE platform_sku_map SET sku_role='base',business_model='paid',
        msrp_usd_cents=?,business_model_source=?,refreshed_at=? WHERE id=? AND sku_role=? AND business_model=?`)
        .run(e.msrpUsdCents,COVERAGE_SOURCE,now.toISOString(),row.id,row.sku_role,row.business_model);
      if(change.changes!==1)throw Error("Promotion compare-and-set failed");
      }
      Object.assign(row,{name:e.name,sku_role:"base",business_model:"paid",msrp_usd_cents:e.msrpUsdCents,
        business_model_source:COVERAGE_SOURCE,refreshed_at:now.toISOString()});
      applied.push({...d,after:{...row},...(metadataRecovery?{metadataRecovery}:{})});
    }
  }).immediate();
  return applied;
}

/** Restore only this feature's catalog fields, never restore an old whole DB
 * over newer observations. New Steam rows remain as manual ratings-only holds,
 * preserving any observations subsequently collected under their real IDs. */
export function rollbackSalesCoverage(db:Database.Database,applied:CoverageDecision[]) {
  db.transaction(()=>{
    for(const d of applied){
      const a=d.after;
      if(!a)throw Error("Missing applied after-image");
      const current=db.prepare("SELECT * FROM platform_sku_map WHERE id=?").get(a.id) as CatalogRow|undefined;
      for(const key of ["title_id","platform","external_sku","concept_id","sku_role","business_model",
        "msrp_usd_cents","business_model_source","is_manual_override","refreshed_at"]){
        if((current?.[key]??null)!==(a[key]??null))throw Error(`Rollback conflict: ${a.id}/${key}`);
      }
      const b=d.before;
      if(d.metadataRecovery){
        const {before,after}=d.metadataRecovery;
        const currentMetadata=db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(a.title_id) as Record<string,any>|undefined;
        if(!currentMetadata || Object.keys(currentMetadata).length!==Object.keys(after).length ||
          Object.keys(after).some(k=>currentMetadata[k]!==after[k])) throw Error(`Rollback conflict: metadata/${a.title_id}`);
        if(before){
          db.prepare(`UPDATE console_title_igdb SET name=?,store_name=?,store_release_date=?,refreshed_at=? WHERE title_id=?`)
            .run(before.name,before.store_name,before.store_release_date,before.refreshed_at,a.title_id);
        }else db.prepare("DELETE FROM console_title_igdb WHERE title_id=?").run(a.title_id);
      }
      db.prepare(`UPDATE platform_sku_map SET sku_role=?,business_model=?,msrp_usd_cents=?,
        business_model_source=?,is_manual_override=?,refreshed_at=? WHERE id=?`)
        .run(b.is_new?"ratings_only":b.sku_role,b.is_new?"unknown":b.business_model,
          b.is_new?null:b.msrp_usd_cents,b.is_new?"manual:coverage_rollback":b.business_model_source,
          b.is_new?1:b.is_manual_override,b.refreshed_at??a.refreshed_at,a.id);
    }
  }).immediate();
  return applied.length;
}
