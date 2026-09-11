/**
 * Repair the Nightreign / base Elden Ring title-collision.
 *
 * Discovered 2026-09-11 after the Phase 4 v0 estimator surfaced an
 * "Elden Ring Nightreign" row with 35.2M Steam units at 880K reviews.
 * The row's Steam SKU was actually 1245620 (base Elden Ring, 1.15M reviews
 * per SteamDB), not 2622380 (real Nightreign, ~191K reviews). A parallel
 * PS5 collision existed on title_id 10402 (SKU UP0700-PPSA04610_00-ELDENRING0000000
 * is base Elden Ring PS4/PS5, not Nightreign — Nightreign has PSN concept id 10010877).
 *
 * State before the repair:
 *   title_id | name                   | platform | external_sku                              | true title
 *   10022    | Elden Ring Nightreign  | steam    | 1245620                                   | base Elden Ring     <- mislabelled
 *   10183    | Elden Ring Nightreign  | steam    | 2622380                                   | real Nightreign     <- correct
 *   10402    | Elden Ring Nightreign  | ps5      | UP0700-PPSA04610_00-ELDENRING0000000      | base Elden Ring     <- mislabelled
 *
 * Repair strategy — relabel, don't delete:
 *   Preserve the historical rating snapshots on 10022 and 10402 (they belong to
 *   base Elden Ring, we just misnamed the title). Rename the IGDB metadata rows
 *   so subsequent estimator runs surface them under "ELDEN RING" instead of
 *   "Elden Ring Nightreign". Clear igdb_id/slug so the next enrich-console-igdb
 *   run re-matches against the correct IGDB entry (Elden Ring, igdb slug 'elden-ring',
 *   igdb id 119133) and repopulates cover_url / dates / dev+pub cleanly.
 *
 *   Delete the stale window_estimates_daily rows on 10022 and 10402 so the board
 *   doesn't show the mislabelled 35.2M Steam Nightreign row for one refresh
 *   cycle. The estimator will re-write correct rows on the next run under the
 *   corrected names.
 *
 * Idempotent: re-running is a no-op after the first successful run (the rows
 * already have the corrected name and no window_estimates_daily entries pending
 * from the pre-repair estimator pass).
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

const MISLABELLED_IDS = [10022, 10402];
const CORRECT_NIGHTREIGN_ID = 10183;

async function main() {
  const db = rawSqlite;
  const nowIso = new Date().toISOString();

  console.log("[repair-nightreign] verifying preconditions");

  // Preconditions: real Nightreign row still present, mislabelled rows still
  // present with the wrong SKUs. If already repaired, exit clean.
  const nightreign = db.prepare(
    `SELECT title_id, name FROM console_title_igdb WHERE title_id = ?`,
  ).get(CORRECT_NIGHTREIGN_ID) as { title_id: number; name: string } | undefined;

  if (!nightreign) {
    console.error(`[repair-nightreign] FATAL: real Nightreign (title_id ${CORRECT_NIGHTREIGN_ID}) not found. Aborting to avoid orphaning data.`);
    process.exit(1);
  }
  console.log(`[repair-nightreign] real Nightreign present: title_id=${nightreign.title_id} name="${nightreign.name}"`);

  const mislabelled = db.prepare(
    `SELECT title_id, name FROM console_title_igdb WHERE title_id IN (${MISLABELLED_IDS.join(",")})`,
  ).all() as Array<{ title_id: number; name: string }>;

  if (mislabelled.length === 0) {
    console.log(`[repair-nightreign] no mislabelled rows found — already repaired. exiting.`);
    return;
  }

  for (const row of mislabelled) {
    console.log(`[repair-nightreign] found mislabelled: title_id=${row.title_id} name="${row.name}"`);
  }

  // ─── Step 1: relabel console_title_igdb rows ─────────────────────────────
  // Set name to "ELDEN RING" (Steam's canonical casing) and null out IGDB
  // metadata so the next enrich pass fetches correct base-Elden-Ring metadata.
  const update = db.prepare(
    `UPDATE console_title_igdb
        SET name = 'ELDEN RING',
            igdb_id = NULL,
            slug = NULL,
            summary = NULL,
            release_date = NULL,
            cover_url = NULL,
            artwork_url = NULL,
            screenshots_json = NULL,
            genres_json = NULL,
            themes_json = NULL,
            platforms_json = NULL,
            developers_json = NULL,
            publishers_json = NULL,
            rating = NULL,
            rating_count = NULL,
            refreshed_at = ?
      WHERE title_id = ?`,
  );

  const tx = db.transaction(() => {
    let relabelled = 0;
    for (const row of mislabelled) {
      const info = update.run(nowIso, row.title_id);
      if (info.changes > 0) relabelled++;
      console.log(`[repair-nightreign] relabelled title_id=${row.title_id}: "Elden Ring Nightreign" -> "ELDEN RING", igdb metadata cleared`);
    }

    // ─── Step 2: drop stale window_estimates_daily rows on the mislabelled ids ──
    const del = db.prepare(
      `DELETE FROM window_estimates_daily WHERE title_id IN (${MISLABELLED_IDS.join(",")})`,
    );
    const delInfo = del.run();
    console.log(`[repair-nightreign] deleted ${delInfo.changes} stale window_estimates_daily rows`);

    return { relabelled, deletedEstimates: delInfo.changes };
  });

  const result = tx();
  console.log(`[repair-nightreign] done. relabelled=${result.relabelled}, deleted_estimates=${result.deletedEstimates}`);
  console.log(`[repair-nightreign] NEXT: enrich-console-igdb refreshes base-Elden-Ring metadata; estimate-console-units repopulates window_estimates_daily under the corrected name.`);
}

main().catch((err) => {
  console.error("[repair-nightreign] FATAL:", err);
  process.exit(1);
});
