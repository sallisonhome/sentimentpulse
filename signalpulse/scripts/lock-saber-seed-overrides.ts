/**
 * Post-fix for backfill-saber-steam-titles.ts (2026-09-12):
 * That script inserted 5 rows via the placeholder-allocator path, then
 * upsertSkuMap UPDATEd them via ON CONFLICT. The ON CONFLICT SET clause
 * doesn't touch is_manual_override, so the rows landed with
 * is_manual_override=0 despite the caller passing isManualOverride=true.
 * Effect: the daily discovery cron could clobber MSRP/business_model on
 * these mid-catalog Saber titles.
 *
 * This one-shot script flips is_manual_override=1 on rows whose
 * business_model_source we ourselves set (saber_manual_seed_2026-09-12).
 * Idempotent — safe to re-run.
 */

import { rawSqlite } from "../server/storage";

const DRY_RUN = process.env.DRY_RUN === "1";

function main() {
  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  lock-saber-seed-overrides.ts   DRY_RUN=${DRY_RUN ? 1 : "unset"}`);
  console.log(`══════════════════════════════════════════════════════════`);

  const rows = rawSqlite.prepare(
    `SELECT external_sku, title_id, business_model, msrp_usd_cents, is_manual_override
       FROM platform_sku_map
      WHERE business_model_source = 'saber_manual_seed_2026-09-12'
      ORDER BY external_sku`
  ).all() as Array<{external_sku:string; title_id:number; business_model:string; msrp_usd_cents:number; is_manual_override:number}>;

  console.log(`\nPre-state (${rows.length} rows):`);
  for (const r of rows) console.log(`  ${JSON.stringify(r)}`);

  const toLock = rows.filter(r => r.is_manual_override === 0);
  console.log(`\nRows to flip is_manual_override=1: ${toLock.length}`);

  if (DRY_RUN) {
    console.log(`(DRY_RUN) would update ${toLock.length} rows`);
    return;
  }

  const upd = rawSqlite.prepare(
    `UPDATE platform_sku_map
        SET is_manual_override = 1
      WHERE business_model_source = 'saber_manual_seed_2026-09-12'
        AND is_manual_override = 0`
  );
  const res = upd.run();
  console.log(`\nUpdated ${res.changes} rows`);

  const post = rawSqlite.prepare(
    `SELECT external_sku, title_id, business_model, msrp_usd_cents, is_manual_override
       FROM platform_sku_map
      WHERE business_model_source = 'saber_manual_seed_2026-09-12'
      ORDER BY external_sku`
  ).all();
  console.log(`\nPost-state:`);
  for (const r of post) console.log(`  ${JSON.stringify(r)}`);
}

main();
