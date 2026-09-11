/**
 * Phase 3 verification — real live-endpoint discovery run.
 *
 * Runs:
 *   1. Steam top-sellers (8 pages = 200 candidates) → classify → write to platform_sku_map
 *      Target: ~100 paid titles after F2P + type-filter.
 *   2. Xbox top-paid + popular channels merged (~50 candidates) → classify → write
 *      Xbox server-side listings hard-cap at 25/page; two channels give us
 *      ~50 unique premium candidates.
 *   3. PS manual seed (4 known paid titles) → write
 * Then asserts:
 *   - At least 80 Steam paid titles classified from top-sellers
 *   - At least 25 Xbox paid titles classified across channels
 *   - Zero F2P titles marked as `paid` on either platform (spot-check known F2Ps)
 *   - Manual-override preservation: running discovery twice does not clobber
 *     a title we manually marked
 */

import { rawSqlite } from "../server/storage";
import { runFullDiscovery, upsertSkuMap } from "../server/signals/console/discovery";

let nextTitleId = 10000;
const titleIdByKey = new Map<string, number>();
function titleIdFor(platform: string, sku: string, _name: string | null): number {
  const key = `${platform}:${sku}`;
  if (!titleIdByKey.has(key)) titleIdByKey.set(key, nextTitleId++);
  return titleIdByKey.get(key)!;
}

// PSN productIds — sourced from live store.playstation.com PDP URLs.
// The old placeholders (…-SPACEMARINE20000, …-STARWARSJEDISUR2, …-ELDENRINGGAME000)
// were synthetic and returned "Product not available" errors from Sony's graphql
// (data_not_found / errorCode 3166081). Every productId below has been verified
// against Sony's productRetrieve endpoint and returned real starRating data.
const PS_MANUAL_SEEDS = [
  { productId: "UP9000-PPSA01413_00-HELLDIVERS200000", businessModel: "paid" as const, msrpUsdCents: 3999, name: "HELLDIVERS 2" },
  { productId: "UP4133-PPSA04452_00-SPACEMARINESII00", businessModel: "paid" as const, msrpUsdCents: 5999, name: "Warhammer 40,000: Space Marine 2" },
  { productId: "UP0006-PPSA07783_00-APPLEJACKGAME000", businessModel: "paid" as const, msrpUsdCents: 6999, name: "STAR WARS Jedi: Survivor" },
  { productId: "UP0700-PPSA04610_00-ELDENRING0000000", businessModel: "paid" as const, msrpUsdCents: 5999, name: "ELDEN RING" },
];

async function main() {
  console.log("─── Phase 3 verification: running full discovery ───");
  const t0 = Date.now();
  const res = await runFullDiscovery({
    steamPages: 8,
    psManualSeeds: PS_MANUAL_SEEDS,
    titleIdFor,
  });
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(res, null, 2));

  // Post-run DB inspection.
  console.log("\n─── platform_sku_map counts by platform × business_model ───");
  const counts = rawSqlite.prepare(`
    SELECT platform, business_model, COUNT(*) AS n
      FROM platform_sku_map
     GROUP BY platform, business_model
     ORDER BY platform, business_model
  `).all();
  console.log(counts);

  console.log("\n─── Sample paid Steam rows ───");
  const sample = rawSqlite.prepare(`
    SELECT platform, external_sku, business_model, msrp_usd_cents, business_model_source
      FROM platform_sku_map
     WHERE platform = 'steam' AND business_model = 'paid'
     ORDER BY msrp_usd_cents DESC
     LIMIT 5
  `).all();
  console.log(sample);

  console.log("\n─── Manual-override preservation test ───");
  // Insert a manual override, then run a discovery pass that would try to change it.
  const overrideSku = "TEST_OVERRIDE_ABC";
  rawSqlite.prepare(`DELETE FROM platform_sku_map WHERE external_sku = ?`).run(overrideSku);
  upsertSkuMap([{
    platform: "xbox", externalSku: overrideSku, titleId: 99999, conceptId: null, skuRole: "base",
    businessModel: "paid", msrpUsdCents: 4999, businessModelSource: "manual_test", isManualOverride: true,
  }]);
  // Now try to overwrite with an automated `unknown` classification.
  upsertSkuMap([{
    platform: "xbox", externalSku: overrideSku, titleId: 99999, conceptId: null, skuRole: "base",
    businessModel: "unknown", msrpUsdCents: null, businessModelSource: "automated_test", isManualOverride: false,
  }]);
  const kept = rawSqlite.prepare(`SELECT business_model, msrp_usd_cents FROM platform_sku_map WHERE external_sku = ?`).get(overrideSku) as { business_model: string; msrp_usd_cents: number };
  const overridePreserved = kept?.business_model === "paid" && kept?.msrp_usd_cents === 4999;
  console.log("override preserved after auto refresh:", overridePreserved, kept);

  // Cleanup test row.
  rawSqlite.prepare(`DELETE FROM platform_sku_map WHERE external_sku = ?`).run(overrideSku);

  // Assertions
  const errors: string[] = [];
  if (res.steam.paid < 80) errors.push(`expected >=80 Steam paid titles, got ${res.steam.paid}`);
  if (res.xbox.paid < 25) errors.push(`expected >=25 Xbox paid titles, got ${res.xbox.paid}`);
  if (res.ps.paid !== 4) errors.push(`expected 4 PS paid seeds, got ${res.ps.paid}`);
  if (!overridePreserved) errors.push(`manual-override preservation FAILED`);

  // Spot check: no `paid` classification for known F2P appids that MIGHT show up in top-sellers.
  const knownF2P = ["578080", "570", "440", "230410", "1085660"];  // PUBG, Dota2, TF2, Warframe, Destiny 2
  const leaks = rawSqlite.prepare(`
    SELECT external_sku, business_model FROM platform_sku_map
     WHERE platform = 'steam' AND external_sku IN (${knownF2P.map(() => "?").join(",")}) AND business_model = 'paid'
  `).all(...knownF2P) as Array<{external_sku:string;business_model:string}>;
  if (leaks.length > 0) errors.push(`F2P titles leaked into paid classification: ${JSON.stringify(leaks)}`);

  if (errors.length > 0) {
    console.error("\n❌ VERIFICATION FAILED:");
    for (const e of errors) console.error("  •", e);
    process.exit(1);
  }
  console.log("\n✅ Phase 3 verification passed.");
  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });
