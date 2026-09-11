/**
 * Seed initial Xbox Game Pass flags on platform_sku_map for v0.3 multiplier
 * calibration. This is a HAND-CURATED starter set drawn from the LTD anchor
 * research pass (anchors/ltd_units_research.md coverage summary — the
 * "Game Pass day-one titles" list) plus a handful of well-known first-party
 * Xbox Game Studios launches.
 *
 * Long-term: this list is a bootstrap seed only. The automated GP flag source
 * will be IGDB's `game_service_availability` field (or an Xbox Wire scrape),
 * refreshed by the same seed-console-data cron that hydrates IGDB metadata.
 * Until that automation lands, this seed keeps v0.3 estimates honest for the
 * dozen or so top-of-board Xbox titles whose ratings are most GP-inflated.
 *
 * Match strategy: fuzzy match on console_title_igdb.name (LIKE '%…%',
 * case-insensitive) since platform_sku_map only stores external_sku. We update
 * every xbox platform_sku_map row whose title_id resolves through the name
 * match. Idempotent — reruns just re-set the same rows.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

// Ordered list of (canonical name, "in game pass?" verdict from research notes).
// Names should be substrings of console_title_igdb.name; we do a case-insensitive
// LIKE '%name%' match. Curated as of 2026-09-11 from the LTD anchor pass; verify
// against Xbox Wire before treating any single-title flag as authoritative.
const GP_TITLES: string[] = [
  // Game Pass day-one launches captured by the researcher's coverage summary
  "Texas Chain Saw Massacre",
  "Ark: Survival Ascended",
  "ARC Raiders",
  "Ready or Not",
  "Helldivers 2", // formerly PS5-exclusive; Xbox launch confirmed day-one on GP
  "Valheim",
  "Phasmophobia",
  "Palworld",
  "Clair Obscur: Expedition 33",
  "Starfield",
  "Grounded 2",
  "Halo: Campaign Evolved",
  "Party Animals",
  "Forza Horizon 5",
  "Forza Horizon 6",
  "Microsoft Flight Simulator 2024",
  "A Plague Tale",   // both Innocence and Requiem
  "It Takes Two",    // Xbox Play Anywhere / EA Play tie-in via GP Ultimate
  // First-party Xbox Game Studios titles that are on GP by policy
  "Sea of Thieves",
  "Gears 5",
  "Halo Infinite",
  "Age of Empires",  // IV / II DE, Xbox versions
  "Grounded",
  "Pentiment",
  "Hi-Fi Rush",
  "Redfall",
  "State of Decay 2",
  "Hellblade",
];

async function main() {
  const db = rawSqlite;
  const nowIso = new Date().toISOString();

  // Resolve title_ids by fuzzy name match. Print each hit so we can eyeball
  // false positives (e.g. "Halo" shouldn't grab "Halo Wars Definitive" if
  // that's not on GP anymore).
  const findByName = db.prepare(
    `SELECT DISTINCT i.title_id, i.name
       FROM console_title_igdb i
       JOIN platform_sku_map p ON p.title_id = i.title_id AND p.platform = 'xbox'
      WHERE i.name LIKE ? COLLATE NOCASE`
  );

  const updateSku = db.prepare(
    `UPDATE platform_sku_map
        SET is_gamepass = 1
      WHERE title_id = ? AND platform = 'xbox'`
  );

  let totalFlagged = 0;
  const misses: string[] = [];
  const tx = db.transaction(() => {
    for (const needle of GP_TITLES) {
      const hits = findByName.all(`%${needle}%`) as Array<{ title_id: number; name: string }>;
      if (hits.length === 0) {
        misses.push(needle);
        continue;
      }
      for (const h of hits) {
        const r = updateSku.run(h.title_id);
        totalFlagged += r.changes;
        console.log(`  gp+ title_id=${h.title_id} "${h.name}" (needle="${needle}") — ${r.changes} sku row(s)`);
      }
    }
  });
  tx();

  const totalGp = (db.prepare(
    `SELECT COUNT(*) AS n FROM platform_sku_map WHERE platform = 'xbox' AND is_gamepass = 1`
  ).get() as { n: number }).n;

  console.log(`[seed-xbox-gamepass-flags] flagged ${totalFlagged} platform_sku_map row(s); ${totalGp} xbox rows now carry is_gamepass=1`);
  if (misses.length) {
    console.log(`[seed-xbox-gamepass-flags] no console_title_igdb match for ${misses.length} needle(s): ${misses.join(", ")}`);
  }
  console.log(`[seed-xbox-gamepass-flags] created_at=${nowIso}`);
}

main().catch((err) => {
  console.error("[seed-xbox-gamepass-flags] FATAL:", err);
  process.exit(1);
});
