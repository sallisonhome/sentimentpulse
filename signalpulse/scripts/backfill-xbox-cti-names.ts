/**
 * scripts/backfill-xbox-cti-names.ts
 *
 * One-off backfill for Xbox `console_title_igdb` (cti) rows that never got
 * created. Symptom: 36 Xbox title_ids appear on the last-7-day leaderboard as
 * raw title_ids (e.g. "10287") because the LEFT JOIN into `console_title_igdb`
 * returns NULL for both `name` and `store_name` — the display falls through.
 *
 * Root cause: `classifyXboxBigIds` catches every displaycatalog failure and
 * yields `{ name: null }` for the affected bigId. `runFullDiscovery` then
 * skips those entries in the `nameRows` array before calling
 * `bootstrapConsoleTitleNames`, so no cti row is ever inserted. If the
 * displaycatalog outage was transient, the missing row is never healed on
 * subsequent daily runs either — the classify call succeeds now, but the
 * bootstrap runs against a fresh `nameRows` batch tied to a fresh discovery
 * result, not against "everything in platform_sku_map that lacks a cti row".
 *
 * What this script does:
 *   1. Find every Xbox `platform_sku_map` row whose `title_id` has NO row in
 *      `console_title_igdb`.
 *   2. Call `fetchXboxRatingSignal` for each `external_sku` (bigId).
 *   3. Feed the successful results into `bootstrapConsoleTitleNames` so a cti
 *      row is written with `name` + `store_name` + `store_header_image_url` +
 *      `store_release_date`. `igdb_id` stays NULL until the next IGDB refresh
 *      picks the row up.
 *
 * Idempotent. Prints a summary. Respects DRY_RUN=1.
 *
 * Manual dispatch via `.github/workflows/signalpulse-backfill-xbox-cti.yml`.
 */

import { rawSqlite } from "../server/storage";
import { fetchXboxRatingSignal } from "../server/signals/console/xbox";
import { bootstrapConsoleTitleNames } from "../server/signals/console/discovery";

const DRY_RUN = process.env.DRY_RUN === "1";
const RATE_LIMIT_MS = 300;   // displaycatalog is generous but be polite

interface MissingXboxRow {
  title_id: number;
  external_sku: string;
}

function findMissingXboxTitleIds(): MissingXboxRow[] {
  // Xbox title_ids that appear in platform_sku_map but have no console_title_igdb row.
  return rawSqlite.prepare(`
    SELECT psm.title_id, psm.external_sku
    FROM platform_sku_map psm
    LEFT JOIN console_title_igdb cti ON cti.title_id = psm.title_id
    WHERE psm.platform = 'xbox'
      AND cti.title_id IS NULL
    ORDER BY psm.title_id
  `).all() as MissingXboxRow[];
}

async function main() {
  const missing = findMissingXboxTitleIds();
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  backfill-xbox-cti-names   DRY_RUN=${DRY_RUN ? 1 : 0}`);
  console.log(`  Xbox title_ids missing from console_title_igdb: ${missing.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (missing.length === 0) {
    console.log("nothing to backfill.");
    return;
  }

  interface NameRow {
    titleId: number;
    name: string;
    headerImageUrl?: string | null;
    releaseDateIso?: string | null;
  }
  const nameRows: NameRow[] = [];
  const failures: Array<{ title_id: number; bigId: string; reason: string }> = [];
  const emptyName: Array<{ title_id: number; bigId: string }> = [];

  for (let i = 0; i < missing.length; i++) {
    const { title_id, external_sku } = missing[i];
    try {
      const r = await fetchXboxRatingSignal({ titleId: title_id, bigId: external_sku });
      if (r.productTitle && r.productTitle.trim().length > 0) {
        nameRows.push({
          titleId: title_id,
          name: r.productTitle.trim(),
          headerImageUrl: r.storeHeaderImageUrl ?? null,
          releaseDateIso: r.storeReleaseDateIso ?? null,
        });
        console.log(`  [${i + 1}/${missing.length}] title_id=${title_id} bigId=${external_sku} → "${r.productTitle}"`);
      } else {
        emptyName.push({ title_id, bigId: external_sku });
        console.log(`  [${i + 1}/${missing.length}] title_id=${title_id} bigId=${external_sku} — displaycatalog returned empty ProductTitle`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ title_id, bigId: external_sku, reason: msg });
      console.log(`  [${i + 1}/${missing.length}] title_id=${title_id} bigId=${external_sku} FAILED: ${msg}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  console.log(`\nResolved names: ${nameRows.length} / ${missing.length}`);
  console.log(`Empty ProductTitle: ${emptyName.length}`);
  console.log(`Fetch failures: ${failures.length}`);

  if (nameRows.length === 0) {
    console.log("no writable rows — exiting.");
    return;
  }

  if (DRY_RUN) {
    console.log(`\nDRY_RUN=1 — not writing to console_title_igdb.`);
    return;
  }

  const result = bootstrapConsoleTitleNames(nameRows);
  console.log(`\nbootstrapConsoleTitleNames: inserted=${result.inserted} updatedName=${result.updatedName} kept=${result.kept}`);

  // Post-write sanity check: how many of the target title_ids now have a name?
  const nowPresent = rawSqlite.prepare(`
    SELECT COUNT(*) AS n
    FROM console_title_igdb
    WHERE title_id IN (${nameRows.map(() => "?").join(",")})
      AND COALESCE(NULLIF(name,''), NULLIF(store_name,'')) IS NOT NULL
  `).get(...nameRows.map(r => r.titleId)) as { n: number };
  console.log(`post-write: ${nowPresent.n}/${nameRows.length} target title_ids now have a resolvable display name.`);

  if (failures.length > 0) {
    console.log(`\nStill missing (${failures.length}) — re-run to retry; displaycatalog was unavailable:`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  title_id=${f.title_id} bigId=${f.bigId}: ${f.reason}`);
    }
    if (failures.length > 10) console.log(`  ...and ${failures.length - 10} more`);
  }
  if (emptyName.length > 0) {
    console.log(`\nEmpty ProductTitle from displaycatalog (${emptyName.length}) — these bigIds may be retired:`);
    for (const e of emptyName.slice(0, 10)) {
      console.log(`  title_id=${e.title_id} bigId=${e.bigId}`);
    }
    if (emptyName.length > 10) console.log(`  ...and ${emptyName.length - 10} more`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
