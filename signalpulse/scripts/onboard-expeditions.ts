/**
 * One-title maintenance runner. Runs from SignalPulse's working directory
 * in an independent process; never starts ingestion, changes auth or restarts.
 * Credentials stay in the existing server DB. Logs contain no sales amounts.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { storage, rawSqlite } from "../server/storage";
import { fetchPortalPage, portalToSalesRows, portalToCountryRows } from "../server/steamworks-portal";
import { fetchHeaderImage } from "../server/steam-header-image";
import { fetchFollowerCount } from "../server/steam-followers";

const apply = process.argv.includes("--apply");
const manifest = JSON.parse(readFileSync(process.env.EXPEDITIONS_MANIFEST!, "utf8"));
assert.equal(manifest.appId, "2477340");
const through = process.env.EXPEDITIONS_THROUGH || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
assert.match(through, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(through < new Date().toISOString().slice(0, 10));
const checkpointPath = process.env.EXPEDITIONS_CHECKPOINT || "/var/lib/signalpulse/expeditions-onboarding.json";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nativeFetch = globalThis.fetch;
// Canonical fetchers do not all set a timeout; bound every operation here.
globalThis.fetch = (input, init = {}) => nativeFetch(input, {
  ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
});
rawSqlite.pragma("busy_timeout = 10000");
// Do not import ingestion or leaderboards: their log/date imports boot index.ts.
// Use the same Partner endpoint, raw schema and chronological cumulative formula.
async function fetchWishlist(key: string, day: string) {
  const url = new URL("https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/");
  url.search = new URLSearchParams({key,appid:manifest.appId,date:day}).toString();
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: any = await response.json();
    const r = data?.response, s = r?.wishlist_summary;
    if (!s || String(r.appid) !== manifest.appId || r.date !== day) return null;
    if (!["wishlist_adds","wishlist_deletes","wishlist_purchases","wishlist_gifts",
      "wishlist_adds_windows","wishlist_adds_mac","wishlist_adds_linux"].every(k=>Number.isFinite(s[k]))) return null;
    return r;
  } catch { return null; }
}
function persistWishlist(productId: number, day: string, r: any) {
  const s = r.wishlist_summary;
  storage.upsertSteamWishlistReporting({productId,date:day,
    wishlistAdds:s.wishlist_adds,wishlistDeletes:s.wishlist_deletes,wishlistPurchases:s.wishlist_purchases,
    wishlistGifts:s.wishlist_gifts,wishlistAddsWindows:s.wishlist_adds_windows,
    wishlistAddsMac:s.wishlist_adds_mac,wishlistAddsLinux:s.wishlist_adds_linux,
    countrySummaryJson:r.country_summary?JSON.stringify(r.country_summary):null,
    languageSummaryJson:r.language_summary?JSON.stringify(r.language_summary):null,
    fetchedAt:new Date().toISOString(),source:"api"});
}
function dates(from: string, to: string) {
  assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
  const result: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) result.push(new Date(t).toISOString().slice(0, 10));
  assert.ok(result.length > 0 && result.length < 10000);
  return result;
}
for (const e of manifest.events) {
  assert.ok(["core","video","press_coverage","demo_beta","promotion"].includes(e.category));
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(e.date <= through && e.source.startsWith("https://"));
}
assert.equal(new Set(manifest.events.map((e: any) => `${e.category}|${e.name}|${e.date}`)).size, manifest.events.length);
const matches = storage.getAllProducts().filter(p => p.steamAppId === manifest.appId || /expeditions/i.test(p.title));
assert.ok(matches.length <= 1, "Conflicting products; operator review required");
if (matches[0]) assert.equal(matches[0].steamAppId, manifest.appId);
console.log(JSON.stringify({ phase: "plan", apply, appId: manifest.appId, existingProductId: matches[0]?.id ?? null,
  salesFrom: manifest.salesFrom, through, researchEvents: manifest.events.length }));

async function main() {
  assert.equal(process.env.EXPEDITIONS_CONFIRM, "CONFIRM");
  const key = storage.getSetting("steam_api_key")?.value;
  assert.ok(key, "Wishlist credential is not configured");
  assert.ok(storage.getSteamworksSession("default")?.cookieValue, "Portal session is not configured");
  const canonical = await fetchWishlist(key, through);
  assert.ok(canonical, "Wishlist preflight failed; no product was created");
  const wishlistFrom = canonical.app_min_date;
  assert.ok(wishlistFrom, "Steam did not provide historical wishlist bounds");
  const wishlistDates = dates(wishlistFrom, through);
  const salesDates = dates(manifest.salesFrom, through);
  const probe = await fetchPortalPage({appId: 2477340, dateStart: through, dateEnd: through,
    cookieHeader: storage.getSteamworksSession("default")!.cookieValue});
  assert.ok(probe.ok && probe.parsed && (probe.parsed.periodSteamUnits != null || probe.parsed.periodDlcUnits != null),
    "Portal did not return report data; no product was created");
  console.log(JSON.stringify({phase:"preflight",wishlistFrom,wishlistDays:wishlistDates.length,
    salesDays:salesDates.length,portalReady:true,apply}));
  if (!apply) return;
  const product = matches[0] || storage.createProduct({
    title: "Expeditions: A MudRunner Game", steamAppId: manifest.appId,
    publisher: "Focus x Saber Interactive", isSaberPublished: false,
    platforms: JSON.stringify(["PC (Steam)", "PS5", "Xbox", "Nintendo Switch", "Epic Games Store"]),
    playerFormat: "co_op", genre: "Driving Sim", releaseDate: manifest.releaseDate,
    targetRetailPriceUsd: 39.99, perPlatformPricing: null, forecastMode: "auto_generate",
  });
  console.log(JSON.stringify({phase:"product",id:product.id,wishlistFrom,through}));
  const checkpoint: any = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath,"utf8")) :
    {appId: manifest.appId, productId: product.id, sales: {}, wishlistFailures: [], salesFailures: []};
  assert.equal(checkpoint.appId, manifest.appId);
  assert.equal(checkpoint.productId, product.id);
  function save() {
    checkpoint.updatedAt = new Date().toISOString();
    writeFileSync(checkpointPath + ".tmp", JSON.stringify(checkpoint), {mode:0o600});
    renameSync(checkpointPath + ".tmp", checkpointPath);
  }
  // Do not generate fictional release-relative default dates for this historical title.
  rawSqlite.transaction(() => {
    let order = Math.max(0, ...storage.getPlsMilestones(product.id).map(m => m.sortOrder));
    for (const e of manifest.events) {
      const existing = storage.getPlsMilestones(product.id).find(m => m.category === e.category && m.name === e.name);
      if (existing) assert.equal(existing.actualDate, e.date, "Existing milestone conflicts with verified manifest");
      const m = existing || storage.createPlsMilestone({
        productId:product.id, category:e.category, name:e.name, actualDate:e.date,
        targetDate:null, isDefault:!!e.isDefault, sortOrder:++order,
      });
      if (e.videoId && !storage.getYoutubeLinks(m.id).some(v => v.youtubeVideoId === e.videoId)) {
        storage.addYoutubeLink({milestoneId:m.id,youtubeVideoId:e.videoId,
          youtubeUrl:`https://www.youtube.com/watch?v=${e.videoId}`,videoTitle:e.name,isOfficial:true,channelName:null});
      }
    }
  })();
  // One product only; canonical writer owns only its deterministic promo names.
  const promo = await fetch("http://127.0.0.1:5003/api/saber/campaigns?game_code=EXPE&platform=Steam");
  assert.ok(promo.ok);
  const payload: any = await promo.json();
  const campaigns = Array.isArray(payload) ? payload : payload.campaigns;
  assert.ok(Array.isArray(campaigns));
  const events = campaigns.filter((c: any) => c.game_code === "EXPE" && c.platform === "Steam")
    .map((c: any) => ({program:c.program,start_date:c.start_date,end_date:c.end_date}));
  assert.ok(events.length > 0 && events.every((e: any) => e.start_date <= e.end_date));
  console.log(JSON.stringify({phase:"pls",research:manifest.events.length,
    promoSync:storage.upsertPromoPlsMilestones(product.id, events)}));
  checkpoint.wishlistFailures = [];
  const existingDates = new Set(storage.getSteamWishlistReporting(product.id).map(r => r.date));
  let streak = 0;
  for (const [index, day] of wishlistDates.entries()) {
    if (!existingDates.has(day) || day === through) {
      const result = day === through ? canonical : await fetchWishlist(key, day);
      if (result) {
        persistWishlist(product.id,day,result); streak = 0;
      } else {
        checkpoint.wishlistFailures.push(day); streak++;
      }
      if (streak >= 5) { save(); throw new Error("Five consecutive wishlist failures; stopped safely"); }
      await sleep(1100);
    }
    if (index % 50 === 0) {save(); console.log(JSON.stringify({phase:"wishlist",processed:index+1,total:wishlistDates.length,failed:checkpoint.wishlistFailures.length}));}
  }
  // Rebuild legacy cumulative chronologically from persisted raw facts on resume.
  let running = 0;
  for (const r of storage.getSteamWishlistReporting(product.id).sort((a,b)=>a.date.localeCompare(b.date))) {
    const delta = r.wishlistAdds-r.wishlistDeletes-r.wishlistPurchases;
    running = Math.max(0,running+delta);
    storage.addSteamWishlist({productId:product.id,date:r.date,cumulativeCount:running,dailyDelta:delta,source:"api"});
  }
  save();
  checkpoint.salesFailures = [];
  streak = 0;
  for (const [index, day] of salesDates.entries()) {
    if (checkpoint.sales[day]) continue;
    let result = day === through ? probe : await fetchPortalPage({appId:2477340,dateStart:day,dateEnd:day,
      cookieHeader:storage.getSteamworksSession("default")!.cookieValue});
    if (!result.ok) {
      await sleep(5000);
      result = await fetchPortalPage({appId:2477340,dateStart:day,dateEnd:day,
        cookieHeader:storage.getSteamworksSession("default")!.cookieValue});
    }
    const parsed = result.parsed;
    if (result.ok && parsed && (parsed.periodSteamUnits != null || parsed.periodDlcUnits != null)) {
      const batchId = `portal-daily-${product.id}-${day}`;
      const rows = portalToSalesRows(parsed,product.id,day,batchId);
      const countries = portalToCountryRows(parsed,product.id,day,day,"day");
      rawSqlite.transaction(() => {
        storage.deleteSteamSalesByBatch(batchId);
        if (rows.length) {
          storage.createSteamSalesUploadBatch({id:batchId,productId:product.id,filename:`portal-daily-${day}.html`,
            fileBytes:result.htmlBytes??0,reportDateStart:day,reportDateEnd:day,publisherName:null,
            rowsParsed:1,rowsIngested:rows.length,rowsSkipped:0,skippedReason:null,uploadedBy:"expeditions-onboarding"});
          storage.upsertSteamSalesRows(rows);
        }
        if (countries.length) storage.upsertSteamSalesByCountry(countries);
      })();
      checkpoint.sales[day] = {rows:rows.length,countries:countries.length}; streak = 0;
    } else { checkpoint.salesFailures.push(day); streak++; }
    save();
    if (streak >= 5) throw new Error("Five consecutive sales failures; stopped safely");
    if (index % 25 === 0) console.log(JSON.stringify({phase:"sales",processed:index+1,total:salesDates.length,failed:checkpoint.salesFailures.length}));
    await sleep(1800);
  }
  const image = await fetchHeaderImage(2477340);
  if (image) storage.updateProductHeaderImage(product.id,image);
  const followers = await fetchFollowerCount(2477340);
  if (followers != null) storage.upsertSteamFollowers({productId:product.id,date:new Date().toISOString().slice(0,10),followerCount:followers,dailyDelta:null,source:"public_scrape"});
  const persistedWishlist = new Set(storage.getSteamWishlistReporting(product.id).map(r=>r.date));
  const persistedSales = new Set(storage.getSteamSales(product.id).map(r=>r.date));
  const missingWishlist = wishlistDates.filter(d=>!persistedWishlist.has(d));
  const missingSales = salesDates.filter(d=>!persistedSales.has(d));
  const unavailableSales = missingSales.filter(d=>!checkpoint.sales[d]);
  const sourceEmptySales = missingSales.filter(d=>checkpoint.sales[d]?.rows===0);
  const summary = storage.getSteamSalesSummary(product.id);
  const revenueResponse = await fetch("http://127.0.0.1:5000/api/promo-support/steam-revenue?steam_app_id=2477340");
  assert.ok(revenueResponse.ok);
  const revenue: any = await revenueResponse.json();
  checkpoint.audit = {productId:product.id,wishlistFrom,through,salesFrom:manifest.salesFrom,
    wishlistDays:persistedWishlist.size,salesDays:persistedSales.size,missingWishlist,unavailableSales,sourceEmptySales,
    pls:storage.getPlsMilestones(product.id).length,header:!!image,followersCaptured:followers!=null,
    revenueEligible:!!product.steamAppId && product.releaseDate <= through,
    revenueReconciled:revenue.product_id === product.id && revenue.found &&
      Math.abs(revenue.net_revenue_usd-summary.baseNetRevenueUsd-summary.dlcNetRevenueUsd)<0.02};
  save();
  console.log(JSON.stringify({phase:"audit",...checkpoint.audit}));
  assert.equal(missingWishlist.length+unavailableSales.length,0,"Source gaps remain; rerun safely");
  assert.ok(checkpoint.audit.revenueReconciled,"Revenue totals do not reconcile");
}
main().catch(error => {
  const safe = String(error?.message || "Unknown failure").replace(/(key|token|cookie)=[^&\s]+/gi,"$1=[redacted]");
  console.error(`Expeditions maintenance stopped: ${safe.slice(0,400)}`);
  process.exitCode=1;
});
