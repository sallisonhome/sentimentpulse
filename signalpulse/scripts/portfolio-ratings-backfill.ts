/**
 * Produce reviewable, idempotent SQL from live storefront collectors.
 * This script NEVER opens or writes a database. Apply its four single-statement
 * files only after explicit approval through SignalPulse DB Admin (write).
 * Existing catalog rows, ratings and sales observations are never overwritten.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPsRatingSignal } from "../server/signals/console/ps";
import { fetchXboxRatingSignal } from "../server/signals/console/xbox";
import { steamAppDetails } from "../server/reviews-ratings-normalize";
import { identityName } from "../server/console-title-identity";
import { RATINGS_ONLY_SOURCE } from "../server/ratings-only-sku";

export const PORTFOLIO_RATINGS = [
  { name: "Bus Bound", appId: "2095420", ps: "EP6853-PPSA22482_00-PROJECTBEE000000", xbox: "9PGTSPHXQ1DQ" },
  { name: "World War Z", appId: "699130", ps: "UP2746-CUSA14046_00-WWZTHEGAME201800", xbox: "BWQ5FC9WDJ6H" },
  { name: "John Carpenter's Toxic Commando", appId: "2157830", ps: "UP4133-PPSA08267_00-TOXICCOMMANDO000", xbox: "9MTGCZ84M503" },
  { name: "Insurgency: Sandstorm", appId: "581320", ps: "UP4133-PPSA09742_00-INSURGENCYSANDST", xbox: "C46KTZB9HK8B" },
  { name: "Docked", appId: "2487300", ps: "EP6853-PPSA22143_00-DOCKEDGAME000000", xbox: "9N74LNKWVFSQ" },
  { name: "SnowRunner", appId: "1465360", ps: "UP4133-PPSA04930_00-SNOWRUNNERGAME01", xbox: "9PNRSC0J6DT8" },
  { name: "RoadCraft", appId: "2104890", ps: "UP4133-PPSA09845_00-ROADBUILDERGAME0", xbox: "9N4J937WLFPZ" },
  { name: "Expeditions: A MudRunner Game", appId: "2477340", ps: "UP4133-PPSA17423_00-SNOWRUNNEREXPEDI", xbox: "9NP9J3T0JWRL" },
] as const;
export type Evidence = {
  name: string; appId: string;
  steam: { name: string; releaseDate: string; header: string | null };
  ps: Awaited<ReturnType<typeof fetchPsRatingSignal>>;
  xbox: Awaited<ReturnType<typeof fetchXboxRatingSignal>>;
};
const q = (v: string | number | null | undefined): string =>
  v == null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;
const tuples = (rows: Array<Array<string | number | null | undefined>>) =>
  rows.map(row => `(${row.map(q).join(",")})`).join(",\n");

export function validateEvidence(evidence: Evidence[]) {
  if (evidence.length !== PORTFOLIO_RATINGS.length) throw new Error("Incomplete eight-title evidence");
  const seen = new Set<string>();
  for (const e of evidence) {
    const expected = PORTFOLIO_RATINGS.find(r => r.appId === e.appId);
    if (!expected || seen.has(e.appId) || e.ps.input.productId !== expected.ps
      || e.xbox.input.bigId !== expected.xbox) throw new Error("Unverified or duplicate SKU");
    seen.add(e.appId);
    for (const name of [e.steam.name, e.ps.productName, e.xbox.productTitle]) {
      if (!name || identityName(name) !== identityName(expected.name)) throw new Error(`Identity mismatch: ${expected.name}`);
    }
    if (!["FULL_GAME", "GAME_BUNDLE"].includes(e.ps.storeDisplayClassification ?? "")) throw new Error("Not a verified full game");
    if (e.xbox.pricing.allSkusZero || !(e.xbox.pricing.baseMsrpUsdCents! > 0)) throw new Error("Unverified paid Xbox SKU");
    for (const snapshot of [e.ps.snapshot, e.xbox.snapshots.find(s => s.windowLabel === "ltd")]) {
      if (!snapshot || !snapshot.ratingCount || snapshot.avgRating == null || snapshot.avgRating < 0 || snapshot.avgRating > 5
        || snapshot.captureDate !== new Date().toISOString().slice(0, 10)) throw new Error("Invalid or stale live ratings");
    }
  }
}

export function makeBackfillSql(evidence: Evidence[], stamp = new Date().toISOString()) {
  validateEvidence(evidence);
  const rows = evidence.flatMap(e => [
    ["steam", e.appId, null, e.steam.name, e.steam.releaseDate, e.steam.header],
    ["ps5", e.ps.input.productId, e.ps.conceptId, e.ps.productName, e.ps.pdpReleaseDate, null],
    ["xbox", e.xbox.input.bigId, null, e.xbox.productTitle, e.xbox.storeReleaseDateIso, e.xbox.storeHeaderImageUrl],
  ] as Array<Array<string | null>>);
  const cte = `WITH verified(platform,sku,concept,name,released,art) AS (VALUES\n${tuples(rows)}\n)`;
  // IDs are allocated inside this single SQLite statement, under its write
  // transaction. Existing (platform,SKU) IDs and business rules stay immutable.
  const maps = `${cte},
missing AS (SELECT v.* FROM verified v WHERE NOT EXISTS
 (SELECT 1 FROM platform_sku_map p WHERE p.platform=v.platform AND p.external_sku=v.sku))
INSERT INTO platform_sku_map(title_id,platform,external_sku,concept_id,sku_role,business_model,
 msrp_usd_cents,business_model_source,is_manual_override,refreshed_at,created_at)
SELECT (SELECT COALESCE(MAX(title_id),9999) FROM platform_sku_map)+ROW_NUMBER() OVER (ORDER BY platform,sku),
 platform,sku,concept,'ratings_only','paid',NULL,${q(RATINGS_ONLY_SOURCE)},1,${q(stamp)},${q(stamp)}
FROM missing;\n`;
  // Fill only absent metadata. Store names remain exactly what the storefront
  // returned; the shared family normalizer handles explicit platform suffixes.
  const metadata = `${cte}
INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,store_header_image_url,refreshed_at,created_at)
SELECT p.title_id,v.name,v.name,v.released,v.art,${q(stamp)},${q(stamp)}
FROM verified v JOIN platform_sku_map p ON p.platform=v.platform AND p.external_sku=v.sku WHERE 1
ON CONFLICT(title_id) DO UPDATE SET
 name=COALESCE(NULLIF(console_title_igdb.name,''),excluded.name),
 store_name=COALESCE(NULLIF(console_title_igdb.store_name,''),excluded.store_name),
 store_release_date=COALESCE(console_title_igdb.store_release_date,excluded.store_release_date),
 store_header_image_url=COALESCE(console_title_igdb.store_header_image_url,excluded.store_header_image_url);\n`;
  const xbox = `${cte}
INSERT INTO xbox_title_cache(big_id,name,art_url,source,first_landed_at,last_verified_at,verified_count)
SELECT sku,name,art,'displaycatalog',${q(stamp)},${q(stamp)},1 FROM verified WHERE platform='xbox'
ON CONFLICT(big_id) DO NOTHING;\n`;
  const samples = evidence.flatMap(e => {
    const x = e.xbox.snapshots.find(s => s.windowLabel === "ltd")!;
    return [
      { sku: e.ps.input.productId, snapshot: e.ps.snapshot },
      { sku: e.xbox.input.bigId, snapshot: { ...x, rawJson: JSON.stringify({
        windows: e.xbox.snapshots.map(s => ({ window: s.windowLabel, rating_count: s.ratingCount, avg_rating: s.avgRating })),
      }) } },
    ];
  });
  const snapshots = `WITH observed(platform,sku,captured,endpoint,n,avg,distribution,raw) AS (VALUES
${tuples(samples.map(({ sku, snapshot: s }) => [s.platform, sku, s.captureDate, s.sourceEndpoint,
    s.ratingCount, s.avgRating, s.distributionJson, s.rawJson]))}
)
INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,avg_rating,
 distribution_json,window_label,is_native_window,sku_count,raw_json,created_at)
SELECT p.title_id,o.platform,o.captured,o.endpoint,o.n,o.avg,o.distribution,'ltd',1,1,o.raw,${q(stamp)}
FROM observed o JOIN platform_sku_map p ON p.platform=o.platform AND p.external_sku=o.sku
WHERE p.business_model='paid' AND p.sku_role='ratings_only' AND p.is_manual_override=1
 AND p.business_model_source=${q(RATINGS_ONLY_SOURCE)}
ON CONFLICT(title_id,platform,capture_date) DO NOTHING;\n`;
  return { maps, metadata, xbox, snapshots };
}

export async function collectEvidence(): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const game of PORTFOLIO_RATINGS) {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&l=english`,
      { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Steam HTTP ${response.status}`);
    const s = steamAppDetails(await response.json(), game.appId);
    const date = Date.parse(s?.release_date?.date);
    if (!s || !Number.isFinite(date) || s.type !== "game") throw new Error(`Invalid Steam game ${game.appId}`);
    const ps = await fetchPsRatingSignal({ titleId: 0, productId: game.ps });
    const xbox = await fetchXboxRatingSignal({ titleId: 0, bigId: game.xbox });
    evidence.push({ name: game.name, appId: game.appId,
      steam: { name: s.name, releaseDate: new Date(date).toISOString().slice(0, 10), header: s.header_image ?? null }, ps, xbox });
  }
  validateEvidence(evidence);
  return evidence;
}

async function main() {
  const output = resolve(process.argv[2] ?? "/tmp/portfolio-ratings-backfill");
  const evidence = await collectEvidence();
  const sql = makeBackfillSql(evidence);
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  for (const [i, [name, content]] of Object.entries(sql).entries()) writeFileSync(`${output}/${i + 1}-${name}.sql`, content);
  console.log(JSON.stringify({ output, titles: evidence.length, consoleObservations: evidence.length * 2, databaseWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
