/**
 * Seed per-title multiplier override for Marvel's Wolverine (PS5) (2026-09-19).
 *
 * The platform-wide PS5 multiplier (24x, id=9, effective_from=2026-09-11) was
 * fitted from LTD anchors on long-since-released, mature titles (Ghost of
 * Yotei 3.3M, BG3 PS5 ~5M, Helldivers 2 PS5-majority of 20M) whose
 * rating-to-owner conversion has had months to catch up. Wolverine is a
 * freshly-launched (2026-09-15), pre-order-heavy blockbuster; its early-window
 * rating conversion is transiently much thinner because a large pre-order
 * cohort has not yet had time to leave a rating. Applying the flat 24x
 * platform default to a 3-day-old launch understates true units.
 *
 * Anchor: Alinea Analytics (Rhys Elliott), published 2026-09-18 — 1.9M copies
 * sold in Wolverine's first 3 days (2026-09-15 through 2026-09-17), ~1M of
 * which were pre-launch digital pre-orders converting at midnight launch (so
 * the 3-day total is heavily front-loaded to day 1, not an even daily
 * run-rate). $130M revenue, 22.9% from physical copies (~77.1% digital,
 * closely matching the PS5 platform default digital_unit_share=0.76 — no
 * change needed to that field).
 * https://alineaanalytics.substack.com/p/wolverine-sells-19m-despite-the-online
 * Corroborating coverage:
 * https://www.ign.com/articles/marvels-wolverine-has-sold-well-early-data-suggests-but-dont-expect-spider-man-numbers
 * https://www.eurogamer.net/marvel-wolverine-sales-ps5-physical-controversial-reviews
 * https://www.gamesradar.com/games/action/marvels-wolverine-beat-death-stranding-2s-entire-lifetime-ps5-revenue-in-3-days-even-with-everyone-making-fun-of-it-analyst-estimates-with-1-9m-copies-sold/
 * https://www.playstationlifestyle.net/2026/09/18/marvel-wolverine-ps5-sales-record-criticism/
 *
 * Calibration (holding digital_unit_share=0.76 fixed):
 *   Anchor date: 2026-09-17 (day 3 of the analyst's window).
 *   store_rating_signal_daily(title_id=10302, platform=ps5, 2026-09-17).rating_count = 25,027
 *   target_owners = 1,900,000 x 0.76 = 1,444,000
 *   implied_multiplier = 1,444,000 / 25,027 = 57.7x  (rounded)
 *
 * IMPORTANT — this is a THIRD-PARTY ANALYST ESTIMATE, not a Sony/Insomniac
 * disclosure. confidence is set to "analyst-estimate" (not
 * "publisher-disclosed") to make that distinction auditable downstream.
 *
 * FORWARD-PROJECTION CAVEAT — estimate-console-units.ts applies whatever
 * override row has the latest effective_from <= today FLATLY to that day's
 * cumulative signal (see override-selection logic, and the LTD accumulator's
 * "override anchors are a floor, not a ceiling" resolver added 2026-09-15,
 * commit 7a4b54e). Applying 57.7x to today's (2026-09-19) signal
 * (rating_count=35,406) yields owners ~2,042,926 -> units ~2,687,000, i.e.
 * ~790K "new units" in just the 2 days since the anchor. Some of that
 * day3->day5 rating growth is plausibly pre-order-backlog rating catch-up
 * rather than all-new sales, and the current override mechanism cannot
 * separate the two. This is a known, accepted limitation — documented here
 * and in sentimentpulse/tasks/ps5-fresh-launch-multiplier-generalization.md
 * so future readers of the resulting LTD jump understand why it happened.
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
    nameLike: "wolverine",
    platform: "ps5",
    multiplier: 57.7,
    ci_pct: 0.40,
    digital_unit_share: 0.76,
    confidence: "analyst-estimate",
    method: "alinea_analytics_3day_estimate_2026_09_18",
    notes:
      "Alinea Analytics (Rhys Elliott) published 2026-09-18: 1.9M copies sold in first 3 days " +
      "(2026-09-15 to 2026-09-17), ~1M of which were pre-launch digital pre-orders converting at " +
      "midnight launch (day-1-heavy, not an even daily run-rate). Anchor paired to the ACTUAL day-3 " +
      "cumulative signal (rating_count=25,027 on 2026-09-17), not a naive even-daily split, per " +
      "explicit instruction to weight day 1 heavily. Implied multiplier = (1,900,000 x 0.76) / 25,027 " +
      "= 57.7x. THIRD-PARTY ANALYST ESTIMATE, not a Sony/Insomniac disclosure -- confidence is " +
      "'analyst-estimate', distinct from 'publisher-disclosed'. digital_unit_share left at platform " +
      "default 0.76 -- Wolverine's own reported 22.9% physical revenue share implies ~77.1% digital, " +
      "closely matching. CAVEAT: this multiplier is applied flatly to whatever the CURRENT cumulative " +
      "signal is on each future day's estimator run (see estimate-console-units.ts override-selection " +
      "logic and the LTD-accumulator override-floor resolver, commit 7a4b54e). Applying 57.7x to " +
      "2026-09-19's signal (35,406) yields units ~2,687,000 -- some of the day3->day5 growth is " +
      "plausibly pre-order-backlog rating catch-up rather than all-new sales; the override mechanism " +
      "cannot separate the two. See sentimentpulse/tasks/ps5-fresh-launch-multiplier-generalization.md " +
      "for the related PS5-exclusive generalization finding.",
    source_url: "https://alineaanalytics.substack.com/p/wolverine-sells-19m-despite-the-online",
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
    console.log(`Next: rerun scripts/estimate-console-units.ts to rebuild window_estimates_daily with the new override.`);
  }
}

main();
