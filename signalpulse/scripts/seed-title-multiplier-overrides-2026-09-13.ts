/**
 * Seed initial per-title multiplier overrides (2026-09-13).
 *
 * The platform-wide Steam multiplier (55×) is a reasonable central tendency
 * per GameDiscoverCo tier medians. Some individual titles nonetheless have
 * strong public anchors that contradict the platform value; for those we
 * install a per-title override row rather than moving the whole platform
 * multiplier.
 *
 * Seeds two overrides:
 *
 *   Wardogs (Steam)  — 19 copies/review
 *     Team17/Everplay Group RNS 2026-09-11 disclosed 1.25M copies at
 *     ~41.9k Steam reviews at that snapshot. Growth has since slowed;
 *     working assumption as of 2026-09-13 is ~1.6M LTD units against
 *     ~83k cumulative signal (windowed reviews-added), which resolves
 *     to a 19× multiplier. Reconciles with the manual LTD anchor
 *     written to revenue_calibration_anchors on 2026-09-13.
 *     https://www.pcgamer.com/games/fps/wardogs-sold-over-1-million-copies-in-its-first-24-hours-making-its-launch-a-bright-spot-in-an-otherwise-tough-year-for-multiplayer-shooters/
 *     https://videogamescritic.com/game/wardogs-1867240
 *
 *   Call of Duty: Modern Warfare 4 (Steam) — 30 copies/review
 *     Preseeded now, in preparation for its 2026-10-23 release. Franchise
 *     copies-per-review has historically been low (Steam reviews are only
 *     ~1/3 of PC playerbase; Battle.net is primary launcher). Prior COD
 *     entries (MW2, MW3) sit near 25-35 copies/review at week 1. Applying
 *     55× at launch would produce a wildly overstated first-week revenue
 *     number the moment the unreleased-title filter releases the row.
 *     https://newsletter.gamediscover.co/p/steam-sales-estimates-why-game-popularity
 *
 * Idempotent per (title_id, platform, effective_from).
 *
 * Resolves title_id from a name-match query against console_title_igdb so
 * the script is portable across environments without hardcoded IDs. If the
 * name-match is ambiguous the script logs the matches and refuses to seed
 * that override; a human must specify the title_id explicitly.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

interface OverrideSeed {
  nameLike: string;                    // SQL LIKE pattern against igdb name/store_name
  platform: string;
  multiplier: number;
  ci_pct: number;
  digital_unit_share: number;
  confidence: string;
  method: string;
  notes: string;
  source_url: string;
}

const SEEDS: OverrideSeed[] = [
  {
    nameLike: "wardogs",
    platform: "steam",
    multiplier: 19,
    ci_pct: 0.30,
    digital_unit_share: 1.0,
    confidence: "publisher-disclosed",
    method: "team17_everplay_rns_2026_09_11",
    notes: "Team17/Everplay Group RNS 2026-09-11: 1.25M copies at ~41.9k Steam reviews snapshot; tuned 2026-09-13 to 19x to reconcile with 1.6M LTD anchor at ~83k cumulative windowed signal.",
    source_url: "https://www.pcgamer.com/games/fps/wardogs-sold-over-1-million-copies-in-its-first-24-hours-making-its-launch-a-bright-spot-in-an-otherwise-tough-year-for-multiplayer-shooters/",
  },
  {
    nameLike: "modern warfare 4",
    platform: "steam",
    multiplier: 30,
    ci_pct: 0.35,
    digital_unit_share: 1.0,
    confidence: "franchise-precedent",
    method: "cod_mw2_mw3_week1_precedent",
    notes: "Preseeded ahead of 2026-10-23 release. COD PC playerbase splits Steam/Battle.net; prior MW2/MW3 sat at ~25-35 copies-per-review at week 1. Platform 55× would produce wildly overstated first-week revenue.",
    source_url: "https://newsletter.gamediscover.co/p/steam-sales-estimates-why-game-popularity",
  },
];

function resolveTitleId(nameLike: string): { title_id: number; name: string } | null {
  const rows = rawSqlite.prepare(`
    SELECT igdb.title_id AS title_id,
           COALESCE(NULLIF(igdb.name,''), NULLIF(igdb.store_name,''), '?') AS name
      FROM console_title_igdb igdb
      JOIN platform_sku_map psm ON psm.title_id = igdb.title_id
     WHERE LOWER(COALESCE(igdb.name,'')) LIKE ?
        OR LOWER(COALESCE(igdb.store_name,'')) LIKE ?
     GROUP BY igdb.title_id
     ORDER BY igdb.title_id
  `).all(`%${nameLike}%`, `%${nameLike}%`) as Array<{ title_id: number; name: string }>;

  if (rows.length === 0) {
    console.warn(`  ! no title matches for LIKE '%${nameLike}%' — skipping`);
    return null;
  }
  if (rows.length > 1) {
    console.warn(`  ! ambiguous match for LIKE '%${nameLike}%' — refusing to seed. Candidates:`);
    for (const r of rows) console.warn(`      title_id=${r.title_id} name="${r.name}"`);
    console.warn(`    Edit this script to pin the exact title_id before re-running.`);
    return null;
  }
  return rows[0];
}

function main() {
  const nowIso = new Date().toISOString();
  const asOf = nowIso.slice(0, 10);

  console.log(`Seeding ${SEEDS.length} per-title multiplier override(s) as of ${asOf}`);

  let seeded = 0, skipped = 0;

  for (const seed of SEEDS) {
    console.log(`\n[${seed.nameLike} / ${seed.platform}] multiplier=${seed.multiplier}`);
    const match = resolveTitleId(seed.nameLike);
    if (!match) { skipped++; continue; }

    console.log(`  → resolved title_id=${match.title_id} name="${match.name}"`);

    const result = rawSqlite.prepare(`
      INSERT INTO title_multiplier_overrides (
        title_id, platform, multiplier, ci_pct, digital_unit_share,
        confidence, method, notes, source_url, effective_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (title_id, platform, effective_from) DO UPDATE SET
        multiplier         = excluded.multiplier,
        ci_pct             = excluded.ci_pct,
        digital_unit_share = excluded.digital_unit_share,
        confidence         = excluded.confidence,
        method             = excluded.method,
        notes              = excluded.notes,
        source_url         = excluded.source_url
    `).run(
      match.title_id, seed.platform, seed.multiplier, seed.ci_pct, seed.digital_unit_share,
      seed.confidence, seed.method, seed.notes, seed.source_url,
      asOf, nowIso,
    );

    const action = result.changes === 1 ? "inserted" : "updated";
    console.log(`  ✓ ${action}`);
    seeded++;
  }

  console.log(`\nDone. Seeded/updated=${seeded}, skipped=${skipped}`);
  if (seeded > 0) {
    console.log(`Next: rerun scripts/estimate-console-units.ts to rebuild window_estimates_daily with the new overrides.`);
  }
}

main();
