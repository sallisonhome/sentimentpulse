/**
 * Offline SQL generator. Does not open a database or execute writes.
 * Input is reviewed native-collector evidence, never search-result scores.
 * New SKUs are ratings_only/unknown: neither paid nor F2P sales universes change.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { identityName } from "../server/console-title-identity";
import { criticSearchTitle } from "../server/reviews-ratings-normalize";
import { CCU_RATINGS_SOURCE } from "../server/ratings-only-sku";

export function storefrontRatingIdentity(name: string) {
  return identityName(criticSearchTitle(name
    .replace(/\s*\((?:(?:Simplified Chinese|Traditional Chinese|English|Korean|Japanese)(?:,\s*)?)+\)\s*$/i, "")
    .replace(/\s*\(F2P\)\s*$/i, "")
    .replace(/\s*[-–:]\s*(?:PlayStation[®™]?\s*4|PS4[™®]?)\s+Edition\s*$/i, "")));
}
export function makeCcuRatingsSql(evidence: any[], stamp = new Date().toISOString()) {
  const q = (v: any): string => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const tuples = (rows: any[][]) => rows.map(row => `(${row.map(q).join(",")})`).join(",\n");
  const seen = new Set<string>(), records: any[] = [];
  for (const e of evidence) {
    if (!/^[1-9]\d*$/.test(e.appid) || !e.steam?.name || e.steam.appId !== e.appid) throw Error("Unverified Steam identity");
    for (const a of e.accepted) {
      const key = `${a.platform}:${a.sku}`;
      if (seen.has(key)) throw Error("Duplicate console SKU");
      seen.add(key);
      const nativeName = a.platform === "ps5" ? a.data.productName : a.data.productTitle;
      const nativeSku = a.platform === "ps5" ? a.data.input.productId : a.data.input.bigId;
      if (nativeSku !== a.sku || nativeName !== a.name ||
        storefrontRatingIdentity(nativeName) !== storefrontRatingIdentity(e.steam.name)) throw Error("Native identity mismatch");
      const url = new URL(a.url);
      if (!(a.platform === "ps5" ? url.hostname === "store.playstation.com" && /^https:$/.test(url.protocol)
        && url.pathname.toUpperCase().includes(`/PRODUCT/${a.sku}`)
        : url.hostname === "www.xbox.com" && url.protocol === "https:" && url.pathname.toUpperCase().includes(a.sku))) throw Error("Unverified source URL");
      if (a.platform === "ps5" && !["FULL_GAME","GAME_BUNDLE"].includes(a.data.storeDisplayClassification)) throw Error("Not a full game");
      if (a.platform === "xbox" && !a.consoleCompatibility?.length) throw Error("Not an Xbox console game");
      const s = a.platform === "ps5" ? a.data.snapshot : a.data.snapshots.find((s:any) => s.windowLabel === "ltd");
      if (!s || s.captureDate !== stamp.slice(0,10) || !(s.ratingCount > 0)
        || !Number.isFinite(s.avgRating) || s.avgRating < 0 || s.avgRating > 5) throw Error("Missing/stale native rating");
      records.push({ ...a, appid: e.appid, s, concept: a.data.conceptId ?? null,
        release: a.data.pdpReleaseDate ?? a.data.storeReleaseDateIso ?? null,
        art: a.data.storeHeaderImageUrl ?? null });
    }
  }
  if (!records.length) throw Error("Empty backfill");
  const cte = `WITH verified(platform,sku,concept,name,released,art) AS (VALUES\n${tuples(records.map(r =>
    [r.platform,r.sku,r.concept,r.name,r.release,r.art]))}\n)`;
  const maps = `${cte}, missing AS (SELECT v.* FROM verified v WHERE NOT EXISTS
    (SELECT 1 FROM platform_sku_map p WHERE p.platform=v.platform AND p.external_sku=v.sku))
INSERT INTO platform_sku_map(title_id,platform,external_sku,concept_id,sku_role,business_model,
 msrp_usd_cents,business_model_source,is_manual_override,refreshed_at,created_at)
SELECT (SELECT COALESCE(MAX(title_id),9999) FROM platform_sku_map)+ROW_NUMBER() OVER(ORDER BY platform,sku),
 platform,sku,concept,'ratings_only','unknown',NULL,${q(CCU_RATINGS_SOURCE)},1,${q(stamp)},${q(stamp)} FROM missing;`;
  const metadata = `${cte}
INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,store_header_image_url,refreshed_at,created_at)
SELECT p.title_id,v.name,v.name,v.released,v.art,${q(stamp)},${q(stamp)}
FROM verified v JOIN platform_sku_map p ON p.platform=v.platform AND p.external_sku=v.sku WHERE 1
ON CONFLICT(title_id) DO UPDATE SET
 name=COALESCE(NULLIF(console_title_igdb.name,''),excluded.name),
 store_name=COALESCE(NULLIF(console_title_igdb.store_name,''),excluded.store_name),
 store_release_date=COALESCE(console_title_igdb.store_release_date,excluded.store_release_date),
 store_header_image_url=COALESCE(console_title_igdb.store_header_image_url,excluded.store_header_image_url);`;
  const xbox = `${cte}
INSERT INTO xbox_title_cache(big_id,name,art_url,source,first_landed_at,last_verified_at,verified_count)
SELECT sku,name,art,'displaycatalog',${q(stamp)},${q(stamp)},1 FROM verified WHERE platform='xbox'
ON CONFLICT(big_id) DO NOTHING;`;
  const links = `INSERT INTO verified_rating_links(platform,external_sku,steam_app_id,store_name,source_url,verified_at,verification_source)
VALUES ${tuples(records.map(r=>[r.platform,r.sku,r.appid,r.name,r.url,stamp,CCU_RATINGS_SOURCE]))}
ON CONFLICT(platform,external_sku) DO NOTHING;`;
  const snapshots = `WITH observed(platform,sku,captured,endpoint,n,avg,distribution,raw) AS (VALUES
${tuples(records.map(r=>[r.platform,r.sku,r.s.captureDate,r.s.sourceEndpoint,r.s.ratingCount,r.s.avgRating,r.s.distributionJson,
  r.platform === "xbox" ? JSON.stringify({windows:r.data.snapshots.map((s:any)=>({window:s.windowLabel,rating_count:s.ratingCount,avg_rating:s.avgRating}))}) : r.s.rawJson]))})
INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,avg_rating,
 distribution_json,window_label,is_native_window,sku_count,raw_json,created_at)
SELECT p.title_id,o.platform,o.captured,o.endpoint,o.n,o.avg,o.distribution,'ltd',1,1,o.raw,${q(stamp)}
FROM observed o JOIN platform_sku_map p ON p.platform=o.platform AND p.external_sku=o.sku
WHERE p.sku_role='ratings_only' AND p.is_manual_override=1 AND p.business_model_source=${q(CCU_RATINGS_SOURCE)}
ON CONFLICT(title_id,platform,capture_date) DO NOTHING;`;
  return { maps, metadata, xbox, links, snapshots };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = JSON.parse(readFileSync(process.argv[2],"utf8"));
  const output = resolve(process.argv[3]);
  mkdirSync(output,{recursive:true});
  Object.entries(makeCcuRatingsSql(evidence)).forEach(([name,sql],i)=>writeFileSync(`${output}/${i+1}-${name}.sql`,sql+"\n"));
  console.log(`Generated five reviewable statements in ${output}; no database writes.`);
}
