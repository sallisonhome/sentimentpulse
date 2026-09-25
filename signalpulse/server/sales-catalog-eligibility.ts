import { identityName } from "./console-title-identity";
import { steamAppDetails } from "./reviews-ratings-normalize";
import { fetchSteamCatalogJson } from "./sales-catalog-steam-http";

export type SalesPlatform = "steam" | "ps5" | "xbox";
export type SaleEvidence = {
  platform: SalesPlatform; sku: string; name: string; checkedAt: string;
  sourceUrls: string[]; released: string | null; msrpUsdCents: number | null;
  eligible: boolean; reason: string; conceptId?: string | null;
};
const edition = /\b(deluxe|ultimate|premium|gold edition|complete edition|anniversary edition|collector|bundle|season pass|expansion|upgrade|dlc|starter pack|founder|trial|friends?['’]? pass)\b/i;
const released = (s: unknown, today: string) => {
  if (typeof s !== "string" || !Number.isFinite(Date.parse(s))) return null;
  const d = new Date(s).toISOString().slice(0,10);
  return d >= "1990-01-01" && d <= today ? d : null;
};
function finish(e: SaleEvidence, expectedName: string): SaleEvidence {
  if (edition.test(e.name)) return {...e,eligible:false,reason:"edition_or_nonbase"};
  if (!e.released) return {...e,eligible:false,reason:"unreleased_or_unknown_date"};
  if (identityName(e.name) !== identityName(expectedName)) return {...e,eligible:false,reason:"identity_mismatch"};
  return e;
}
export function xboxSaleEvidence(raw: any, sku: string, expectedName: string, now = new Date()): SaleEvidence {
  const p = raw?.Product ?? (raw?.Products?.length === 1 ? raw.Products[0] : null);
  const e: SaleEvidence = {platform:"xbox",sku,name:p?.LocalizedProperties?.[0]?.ProductTitle??"",
    checkedAt:now.toISOString(),sourceUrls:[`https://displaycatalog.mp.microsoft.com/v7.0/products/${sku}?market=US&languages=en-us`],
    released:released(p?.MarketProperties?.[0]?.OriginalReleaseDate,now.toISOString().slice(0,10)),
    msrpUsdCents:null,eligible:false,reason:"no_paid_purchase"};
  if (p?.ProductId !== sku) return {...e,reason:"sku_mismatch"};
  if (p.ProductType !== "Game" || p.Properties?.IsDemo ||
    !p.Properties?.XboxConsoleGenCompatible?.some((x:string)=>["ConsoleGen8","ConsoleGen9"].includes(x)))
    return {...e,reason:"not_console_base_game"};
  const prices = new Set<number>();
  for (const d of p.DisplaySkuAvailabilities??[]) {
    if (d.Sku?.SkuType?.toLowerCase() !== "full" || d.Sku?.Properties?.IsPreOrder || d.Sku?.Properties?.IsSubscription) continue;
    for (const a of d.Availabilities??[]) {
      const price=a.OrderManagementData?.Price, c=a.Conditions;
      if (!a.Actions?.includes("Purchase") || price?.CurrencyCode!=="USD" || !(price.MSRP>0)) continue;
      // Subscription/license and historical offers cannot establish retail eligibility.
      if (c?.StartDate && Date.parse(c.StartDate)>now.getTime()) continue;
      if (c?.EndDate && Date.parse(c.EndDate)<=now.getTime()) continue;
      prices.add(Math.round(price.MSRP*100));
    }
  }
  if (prices.size===1) {e.msrpUsdCents=Array.from(prices)[0];e.eligible=true;e.reason="verified_paid_base";}
  else if (prices.size>1) e.reason="ambiguous_retail_price";
  return finish(e,expectedName);
}

/** Parse exact-product Apollo caches, never the first price/release date on a
 * page (which can belong to an upsell, subscription or different edition). */
export function psSaleEvidence(html: string, sku: string, expectedName: string, url: string, now = new Date()): SaleEvidence {
  const products:any[]=[], ctas:any[]=[];
  for (const m of Array.from(html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g))) {
    try {
      const cache=JSON.parse(m[1]).cache;
      if (!cache || typeof cache!=="object") continue;
      const p=cache[`Product:${sku}`];
      if (p?.id===sku) products.push(p);
      for (const c of Object.values(cache) as any[]) {
        if (c?.__typename==="GameCTA" && c.action?.param?.some((p:any)=>
          p.name==="skuId" && typeof p.value==="string" && p.value.startsWith(sku+"-"))) ctas.push(c);
      }
    } catch { /* unrelated or malformed script: no evidence */ }
  }
  const names=Array.from(new Set(products.map(p=>p.name).filter(Boolean))) as string[];
  const concepts=Array.from(new Set(products.map(p=>p.concept?.id??p.concept?.__ref?.replace(/^Concept:/,"")).filter(Boolean))) as string[];
  const dates=Array.from(new Set(products.map(p=>released(p.releaseDate,now.toISOString().slice(0,10))).filter(Boolean))) as string[];
  const e: SaleEvidence={platform:"ps5",sku,name:names.length===1?names[0]:"",checkedAt:now.toISOString(),
    sourceUrls:[url],released:dates.length===1?dates[0]:null,msrpUsdCents:null,
    conceptId:concepts.length===1?concepts[0]:null,eligible:false,reason:"no_paid_purchase"};
  if (!products.length || names.length!==1 || concepts.length>1) return {...e,reason:"sku_identity_unavailable"};
  if (!products.some(p=>p.platforms?.includes("PS5"))) return {...e,reason:"not_ps5_game"};
  if (!products.some(p=>["FULL_GAME","GAME_BUNDLE"].includes(p.storeDisplayClassification)))
    return {...e,reason:"not_full_game"};
  if (ctas.some(c=>c.meta?.preOrder===true)) return {...e,reason:"preorder"};
  const prices=new Set<number>();
  for (const c of ctas) {
    const p=c.price;
    if(c.type!=="ADD_TO_CART" || c.action?.type!=="ADD_TO_CART" ||
      p?.currencyCode!=="USD" || p.isFree || p.isTiedToSubscription || p.isExclusive ||
      !(p.basePriceValue>0) || !Number.isSafeInteger(p.basePriceValue)) continue;
    prices.add(p.basePriceValue);
  }
  if(prices.size===1){e.msrpUsdCents=Array.from(prices)[0];e.eligible=true;e.reason="verified_paid_base";}
  else if(prices.size>1)e.reason="ambiguous_retail_price";
  return finish(e,expectedName);
}
/** PS ratings are concept-wide across regions. A regional base can use USD
 * retail pricing only from a verified PS5 base in the exact same concept.
 * Never convert GBP/JPY numerically or take a deluxe/subscription price. */
export function psUsdSibling(primary:SaleEvidence,html:string,url:string,now=new Date()):SaleEvidence {
  if(primary.reason!=="no_paid_purchase" || !primary.conceptId || !primary.released)return primary;
  const skus=new Set<string>();
  for(const m of Array.from(html.matchAll(/"Product:([^"]+)"/g)))skus.add(m[1]);
  const candidates=Array.from(skus).map(sku=>psSaleEvidence(html,sku,primary.name,url,now))
    .filter(e=>e.eligible && e.conceptId===primary.conceptId);
  const prices=new Set(candidates.map(e=>e.msrpUsdCents));
  if(prices.size!==1)return primary;
  return {...primary,eligible:true,reason:"verified_paid_base_same_concept_usd",
    msrpUsdCents:Array.from(prices)[0],sourceUrls:[...primary.sourceUrls,url]};
}

export function steamSaleEvidence(raw:any,sku:string,expectedName:string,now=new Date()): SaleEvidence {
  const p=steamAppDetails(raw,sku);
  const e:SaleEvidence={platform:"steam",sku,name:p?.name??"",checkedAt:now.toISOString(),
    sourceUrls:[`https://store.steampowered.com/api/appdetails?appids=${sku}&cc=us&l=english`],
    released:p?.release_date?.coming_soon?null:released(p?.release_date?.date,now.toISOString().slice(0,10)),
    msrpUsdCents:null,eligible:false,reason:"not_paid_base"};
  if(p?.type==="game" && !p.is_free && p.price_overview?.currency==="USD" && p.price_overview.initial>0){
    e.eligible=true;e.reason="verified_paid_base";e.msrpUsdCents=p.price_overview.initial;
  }
  return finish(e,expectedName);
}

export async function fetchSaleEvidence(platform:SalesPlatform,sku:string,name:string): Promise<SaleEvidence> {
  if(platform==="ps5"){
    const prefix=sku.slice(0,2);
    const locale=({EP:"en-gb",EB:"en-gb",JP:"ja-jp",JB:"ja-jp",HP:"en-sg"} as Record<string,string>)[prefix]??"en-us";
    const url=`https://store.playstation.com/${locale}/product/${encodeURIComponent(sku)}`;
    const r=await fetch(url,{headers:{"Accept":"text/html","User-Agent":"Mozilla/5.0 SignalPulse/CatalogAudit"},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error(`PS storefront HTTP ${r.status}`);
    const primary=psSaleEvidence(await r.text(),sku,name,url);
    if(locale!=="en-us" && primary.reason==="no_paid_purchase" && primary.conceptId && primary.released){
      const us=`https://store.playstation.com/en-us/concept/${encodeURIComponent(primary.conceptId)}`;
      const sibling=await fetch(us,{headers:{"Accept":"text/html","User-Agent":"Mozilla/5.0 SignalPulse/CatalogAudit"},signal:AbortSignal.timeout(15000)});
      if(sibling.ok)return psUsdSibling(primary,await sibling.text(),us);
    }
    return primary;
  }
  const url=platform==="xbox"
    ?`https://displaycatalog.mp.microsoft.com/v7.0/products/${sku}?market=US&languages=en-us`
    :`https://store.steampowered.com/api/appdetails?appids=${sku}&cc=us&l=english`;
  if(platform==="steam")return steamSaleEvidence(await fetchSteamCatalogJson(url),sku,name);
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`${platform} storefront HTTP ${r.status}`);
  return xboxSaleEvidence(await r.json(),sku,name);
}
