/**
 * Backfill missing Saber-published Steam titles into platform_sku_map.
 *
 * Why: 5 released Saber Steam titles have full actuals in steam_sales_daily
 * but are absent from platform_sku_map, so they cannot appear on any console
 * leaderboard and cannot serve as revenue-calibration anchors. They are absent
 * because the daily discovery cron only ingests the current Steam top-sellers
 * page, which these mid-catalog titles have long since dropped off.
 *
 * These rows are written with is_manual_override=1 so future discovery runs
 * cannot clobber MSRP or business_model. title_id is minted from the current
 * MAX(title_id)+1 using the same atomic allocator pattern verify-discovery.ts
 * uses (BEGIN IMMEDIATE + placeholder reservation), because we want the ids
 * pinned forever.
 *
 * MSRPs below are the current NON-SALE MSRP fetched live from Steam's
 * appdetails endpoint on 2026-09-12 (the `price_overview.initial` field,
 * which reflects the reference price Steam shows above any active discount).
 *
 * DRY_RUN=1 prints the plan without writing.
 */

import { rawSqlite } from "../server/storage";
import { upsertSkuMap } from "../server/signals/console/discovery";

const DRY_RUN = process.env.DRY_RUN === "1";

// Saber-published Steam titles present in steam_sales_daily but missing from
// platform_sku_map as of 2026-09-12. Backfilled to enable revenue-calibration
// anchoring for these titles, whether or not they qualify for the top-100
// display leaderboard on any given day.
const SABER_STEAM_BACKFILL = [
  { appId: "699130",  name: "World War Z",                          msrpUsdCents: 2999 },
  { appId: "581320",  name: "Insurgency: Sandstorm",                msrpUsdCents: 2999 },
  { appId: "1486920", name: "Tempest Rising",                       msrpUsdCents: 3999 },
  { appId: "2157830", name: "John Carpenter's Toxic Commando",      msrpUsdCents: 3999 },
  { appId: "2104890", name: "RoadCraft",                            msrpUsdCents: 3999 },
];

// Atomic allocator (same pattern as verify-discovery.ts).
const existingLookup = rawSqlite.prepare(
  `SELECT title_id FROM platform_sku_map WHERE platform = ? AND external_sku = ?`
);
const maxTitleIdStmt = rawSqlite.prepare(
  `SELECT COALESCE(MAX(title_id), 9999) AS max_id FROM platform_sku_map`
);
const reserveStmt = rawSqlite.prepare(
  `INSERT INTO platform_sku_map
     (title_id, platform, external_sku, concept_id, sku_role,
      business_model, msrp_usd_cents, business_model_source, is_manual_override,
      refreshed_at, created_at)
   VALUES (?, ?, ?, NULL, 'base', 'unknown', NULL, 'allocator_reservation', 0, ?, ?)
   ON CONFLICT(platform, external_sku) DO NOTHING`
);

function titleIdFor(platform: string, sku: string): number {
  const existing = existingLookup.get(platform, sku) as { title_id: number } | undefined;
  if (existing) return existing.title_id;
  const nowIso = new Date().toISOString();
  const allocateTx = rawSqlite.transaction((): number => {
    const inside = existingLookup.get(platform, sku) as { title_id: number } | undefined;
    if (inside) return inside.title_id;
    const { max_id } = maxTitleIdStmt.get() as { max_id: number };
    const fresh = max_id + 1;
    reserveStmt.run(fresh, platform, sku, nowIso, nowIso);
    return fresh;
  });
  return allocateTx.immediate();
}

function main() {
  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  backfill-saber-steam-titles.ts   DRY_RUN=${DRY_RUN ? 1 : "unset"}`);
  console.log(`══════════════════════════════════════════════════════════`);

  console.log(`\nPre-state: existing rows in platform_sku_map for these appIds:`);
  for (const t of SABER_STEAM_BACKFILL) {
    const row = rawSqlite.prepare(
      `SELECT title_id, business_model, msrp_usd_cents, is_manual_override, business_model_source
         FROM platform_sku_map WHERE platform = 'steam' AND external_sku = ?`
    ).get(t.appId);
    console.log(`  ${t.appId.padEnd(9)} ${t.name.padEnd(40)} ${row ? JSON.stringify(row) : "(absent)"}`);
  }

  console.log(`\nPlan:`);
  const upsertRows = SABER_STEAM_BACKFILL.map(t => {
    // If DRY_RUN, don't actually reserve — just show what the ID would be.
    let tid: number;
    if (DRY_RUN) {
      const existing = existingLookup.get("steam", t.appId) as { title_id: number } | undefined;
      if (existing) {
        tid = existing.title_id;
      } else {
        const { max_id } = maxTitleIdStmt.get() as { max_id: number };
        tid = max_id + 1;  // approximation for display; real run will re-check
      }
    } else {
      tid = titleIdFor("steam", t.appId);
    }
    const row = {
      platform: "steam" as const,
      externalSku: t.appId,
      titleId: tid,
      conceptId: null,
      skuRole: "base",
      businessModel: "paid" as const,
      msrpUsdCents: t.msrpUsdCents,
      businessModelSource: "saber_manual_seed_2026-09-12",
      isManualOverride: true,
    };
    console.log(`  steam:${t.appId.padEnd(9)} title_id=${tid.toString().padEnd(5)} $${(t.msrpUsdCents/100).toFixed(2).padStart(6)}  ${t.name}`);
    return row;
  });

  if (DRY_RUN) {
    console.log(`\n(DRY_RUN) would upsert ${upsertRows.length} rows with is_manual_override=1`);
    return;
  }

  console.log(`\nApplying...`);
  const res = upsertSkuMap(upsertRows);
  console.log(`  inserted:           ${res.inserted}`);
  console.log(`  updated:            ${res.updated}`);
  console.log(`  preservedOverride:  ${res.preservedOverride}`);

  console.log(`\nPost-state:`);
  for (const t of SABER_STEAM_BACKFILL) {
    const row = rawSqlite.prepare(
      `SELECT title_id, business_model, msrp_usd_cents, is_manual_override, business_model_source
         FROM platform_sku_map WHERE platform = 'steam' AND external_sku = ?`
    ).get(t.appId);
    console.log(`  ${t.appId.padEnd(9)} ${t.name.padEnd(40)} ${JSON.stringify(row)}`);
  }
}

main();
