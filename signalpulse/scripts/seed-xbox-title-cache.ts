/**
 * scripts/seed-xbox-title-cache.ts   (2026-09-12)
 *
 * One-off seed of the new xbox_title_cache (immutable-once-landed).
 *
 * Two phases:
 *
 *   PHASE 1 — Seed from existing good data in console_title_igdb.
 *     For every Xbox bigId in platform_sku_map, if we already have a
 *     non-empty name in console_title_igdb (either via IGDB or the
 *     store_name fallback) OR any cover art at all, write it into
 *     xbox_title_cache. Source is recorded as 'seeded_from_cti'. This is a
 *     one-time historical rescue — everything after runs the 3-source
 *     resolver.
 *
 *   PHASE 2 — Run the 3-source resolver against every Xbox bigId still
 *     missing from xbox_title_cache. Resolver = SSR productSummaries \u2192
 *     displaycatalog \u2192 marketplace PDP; first success wins. Failed bigIds
 *     are added to xbox_bigid_retry_queue.
 *
 * Idempotent \u2014 rerunning is safe. Respects DRY_RUN=1.
 *
 * Post-run: prints xbox-title-health-style counts.
 */

import { rawSqlite } from "../server/storage";
import { landXboxBigIds } from "../server/signals/console/xbox-title-resolver";

const DRY_RUN = process.env.DRY_RUN === "1";

interface Psm {
  external_sku: string;
  title_id: number;
}

interface CtiForXbox {
  external_sku: string;
  name: string | null;
  store_name: string | null;
  cover_url: string | null;
  store_header_image_url: string | null;
  match_confidence: string | null;
}

function bar(msg: string): void {
  console.log(`─── ${msg} ${"─".repeat(Math.max(0, 72 - msg.length))}`);
}

async function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  seed-xbox-title-cache   DRY_RUN=${DRY_RUN ? 1 : 0}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  bar("PHASE 1 — seed from console_title_igdb (historical rescue)");

  // Pull every Xbox row + whatever we know about its title_id's cti row.
  // Prefer the same field priority the leaderboard used before the swap.
  const candidates = rawSqlite.prepare(`
    SELECT psm.external_sku,
           cti.name                  AS name,
           cti.store_name            AS store_name,
           cti.cover_url             AS cover_url,
           cti.store_header_image_url AS store_header_image_url,
           cti.match_confidence      AS match_confidence
      FROM platform_sku_map psm
      LEFT JOIN console_title_igdb cti ON cti.title_id = psm.title_id
     WHERE psm.platform = 'xbox'
       AND psm.business_model = 'paid'
       AND psm.sku_role = 'base'
  `).all() as CtiForXbox[];

  const already = new Set(
    (rawSqlite.prepare(`SELECT big_id FROM xbox_title_cache`).all() as Array<{ big_id: string }>)
      .map(r => r.big_id),
  );
  console.log(`  candidate Xbox rows: ${candidates.length}`);
  console.log(`  already in xbox_title_cache: ${already.size}`);

  const rescueRows: Array<{ big_id: string; name: string; art_url: string | null }> = [];
  for (const c of candidates) {
    if (already.has(c.external_sku)) continue;
    // Same fallback priority the leaderboard used:
    //   match_confidence='low' → store_name > name
    //   else                   → name > store_name
    const lowConf = c.match_confidence === "low";
    const name = lowConf
      ? (c.store_name || c.name || "")
      : (c.name || c.store_name || "");
    const art = lowConf
      ? (c.store_header_image_url || c.cover_url || null)
      : (c.cover_url || c.store_header_image_url || null);
    if (name.trim().length === 0) continue;
    rescueRows.push({ big_id: c.external_sku, name: name.trim(), art_url: art });
  }

  console.log(`  rescuable from cti: ${rescueRows.length}`);

  if (!DRY_RUN && rescueRows.length > 0) {
    const now = new Date().toISOString();
    const stmt = rawSqlite.prepare(`
      INSERT INTO xbox_title_cache (big_id, name, art_url, source, first_landed_at, last_verified_at, verified_count)
      VALUES (?, ?, ?, 'seeded_from_cti', ?, ?, 1)
      ON CONFLICT(big_id) DO NOTHING
    `);
    const tx = rawSqlite.transaction((batch: typeof rescueRows) => {
      for (const r of batch) stmt.run(r.big_id, r.name, r.art_url, now, now);
    });
    tx(rescueRows);
    console.log(`  ✔ inserted ${rescueRows.length} rows from cti seed`);
  } else if (DRY_RUN) {
    console.log(`  (DRY_RUN — not writing)`);
  }

  bar("PHASE 2 — resolve remaining bigIds via SSR + displaycatalog + PDP");

  // Any Xbox bigId still not in xbox_title_cache after phase 1.
  const remaining = rawSqlite.prepare(`
    SELECT psm.external_sku AS external_sku
      FROM platform_sku_map psm
      LEFT JOIN xbox_title_cache xtc ON xtc.big_id = psm.external_sku
     WHERE psm.platform = 'xbox'
       AND psm.business_model = 'paid'
       AND psm.sku_role = 'base'
       AND xtc.big_id IS NULL
     ORDER BY psm.title_id
  `).all() as Array<{ external_sku: string }>;
  console.log(`  bigIds to resolve: ${remaining.length}`);

  if (remaining.length > 0) {
    if (DRY_RUN) {
      console.log(`  (DRY_RUN — not calling resolver)`);
    } else {
      const bigIds = remaining.map(r => r.external_sku);
      const res = await landXboxBigIds(bigIds);
      console.log(`\n  resolver result:`);
      console.log(`    total=${res.total}`);
      console.log(`    alreadyLanded=${res.alreadyLanded}`);
      console.log(`    newlyLanded=${res.newlyLanded}`);
      console.log(`    queuedForRetry=${res.queuedForRetry}`);
      console.log(`    by source:  ssr=${res.landedBySource.ssr_productsummaries} dc=${res.landedBySource.displaycatalog} pdp=${res.landedBySource.marketplace_pdp}`);
    }
  }

  bar("POST-RUN HEALTH");

  const totalPaid = (rawSqlite.prepare(
    `SELECT COUNT(*) AS n FROM platform_sku_map WHERE platform = 'xbox' AND business_model = 'paid' AND sku_role = 'base'`,
  ).get() as { n: number }).n;
  const missing = (rawSqlite.prepare(
    `SELECT COUNT(*) AS n
       FROM platform_sku_map psm
       LEFT JOIN xbox_title_cache xtc ON xtc.big_id = psm.external_sku
      WHERE psm.platform = 'xbox' AND psm.business_model = 'paid' AND psm.sku_role = 'base' AND xtc.big_id IS NULL`,
  ).get() as { n: number }).n;
  const queue = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue`).get() as { n: number }).n;
  const cache = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_title_cache`).get() as { n: number }).n;

  console.log(`  xbox paid base rows:       ${totalPaid}`);
  console.log(`  xbox_title_cache size:     ${cache}`);
  console.log(`  missing (hidden from LB):  ${missing}`);
  console.log(`  retry queue depth:         ${queue}`);
  console.log(`  healthy:                   ${missing === 0 ? "YES" : "NO"}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
