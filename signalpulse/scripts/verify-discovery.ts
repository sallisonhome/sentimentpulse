/**
 * Phase 3 verification — real live-endpoint discovery run.
 *
 * Runs:
 *   1. Steam top-sellers (8 pages = 200 candidates) → classify → write to platform_sku_map
 *      Target: ~100 paid titles after F2P + type-filter.
 *   2. Xbox emerald top-paid (paginated, top-100) → classify → write.
 *   3. PS5 top-selling (categoryGridRetrieve sales30, top-100) → classify → write,
 *      plus a small manual-seed override set for Saber-relevant titles.
 * Then asserts:
 *   - At least 80 Steam paid titles classified from top-sellers
 *   - At least 80 Xbox paid titles classified from emerald pagination
 *   - At least 90 PS5 paid titles from category discovery (allow slack for graphql hiccups)
 *   - Zero F2P titles marked as `paid` on Steam (spot-check known F2Ps)
 *   - Manual-override preservation: running discovery twice does not clobber
 *     a title we manually marked
 */

import { rawSqlite } from "../server/storage";
import { runFullDiscovery, upsertSkuMap } from "../server/signals/console/discovery";

// Prefer the DB's existing title_id when a row already exists — upsertSkuMap
// pins title_id on conflict (it is IMMUTABLE once written), so consulting the
// DB first keeps this in-process allocator from burning fresh numbers on every
// run and drifting the visible id relative to what the DB holds. New SKUs get
// a fresh id from the counter; the counter is seeded above the current max so
// it never collides with an existing id.
const maxRow = rawSqlite.prepare(
  `SELECT COALESCE(MAX(title_id), 9999) AS max_id FROM platform_sku_map`
).get() as { max_id: number };
let nextTitleId = maxRow.max_id + 1;
const titleIdByKey = new Map<string, number>();
const existingLookup = rawSqlite.prepare(
  `SELECT title_id FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
);
function titleIdFor(platform: string, sku: string, _name: string | null): number {
  const key = `${platform}:${sku}`;
  const cached = titleIdByKey.get(key);
  if (cached != null) return cached;
  const existing = existingLookup.get(platform, sku) as { title_id: number } | undefined;
  const id = existing?.title_id ?? nextTitleId++;
  titleIdByKey.set(key, id);
  return id;
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

  console.log("\n─── title_id pinning test (immutable-on-conflict invariant) ───");
  // Insert a row at a known title_id, then attempt to "reallocate" it to a
  // different title_id via a discovery-shaped upsert. The DB row's title_id
  // MUST NOT change — store_rating_signal_daily and every joined report key
  // off title_id, so drift orphans historical rows.
  const pinSku = "TEST_PIN_ABC";
  rawSqlite.prepare(`DELETE FROM platform_sku_map WHERE external_sku = ?`).run(pinSku);
  upsertSkuMap([{
    platform: "xbox", externalSku: pinSku, titleId: 88888, conceptId: null, skuRole: "base",
    businessModel: "paid", msrpUsdCents: 5999, businessModelSource: "pin_test", isManualOverride: false,
  }]);
  // Now discovery hands out a different title_id for the same SKU (simulates
  // the allocator burning a fresh number on a re-run).
  upsertSkuMap([{
    platform: "xbox", externalSku: pinSku, titleId: 77777, conceptId: null, skuRole: "base",
    businessModel: "paid", msrpUsdCents: 6499, businessModelSource: "pin_test_reallocated", isManualOverride: false,
  }]);
  const pinRow = rawSqlite.prepare(
    `SELECT title_id, msrp_usd_cents FROM platform_sku_map WHERE external_sku = ?`
  ).get(pinSku) as { title_id: number; msrp_usd_cents: number };
  const titleIdPinned = pinRow?.title_id === 88888;
  const msrpUpdated = pinRow?.msrp_usd_cents === 6499;
  console.log(`title_id pinned at 88888 across re-upsert: ${titleIdPinned} (got ${pinRow?.title_id}); msrp updated to 6499: ${msrpUpdated} (got ${pinRow?.msrp_usd_cents})`);
  rawSqlite.prepare(`DELETE FROM platform_sku_map WHERE external_sku = ?`).run(pinSku);

  // Assertions
  const errors: string[] = [];
  if (res.steam.paid < 80) errors.push(`expected >=80 Steam paid titles, got ${res.steam.paid}`);
  if (res.xbox.paid < 80) errors.push(`expected >=80 Xbox paid titles, got ${res.xbox.paid}`);
  if (res.ps.paid < 90) errors.push(`expected >=90 PS5 paid titles (auto+manual), got ${res.ps.paid}`);
  if (!overridePreserved) errors.push(`manual-override preservation FAILED`);
  if (!titleIdPinned) errors.push(`title_id pinning FAILED — row title_id changed after re-upsert (was 88888, now ${pinRow?.title_id})`);
  if (!msrpUpdated) errors.push(`title_id pinning test: msrp did NOT update as expected — non-title_id columns should still refresh (expected 6499, got ${pinRow?.msrp_usd_cents})`);

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
