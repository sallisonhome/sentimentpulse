/**
 * Revise the Marvel's Wolverine (PS5) per-title multiplier override, cutting
 * it 15% below the original Alinea-anchor calibration (2026-09-19, same day).
 *
 * Original seed (seed-title-multiplier-override-2026-09-19-wolverine.ts,
 * merged in PR #84): multiplier=57.7x, calibrated from Alinea Analytics'
 * 1.9M-units-in-3-days estimate against the day-3 rating signal
 * (rating_count=25,027 on 2026-09-17).
 *
 * This revision applies an explicit user-directed 15% downward adjustment to
 * that multiplier, per direct instruction on 2026-09-19 following the
 * initial deploy/verification. No new anchor or source changed — this is a
 * manual conservatism adjustment on top of the existing analyst-estimate
 * anchor, not a new independent calibration.
 *
 *   original multiplier = 57.7
 *   revised  multiplier = 57.7 x 0.85 = 49.045  (-15.0%)
 *
 * ci_pct, digital_unit_share, and confidence are left unchanged (0.40, 0.76,
 * "analyst-estimate") -- only the multiplier itself is cut. method is tagged
 * distinctly (suffixed "_revised_minus15pct") so the audit trail shows this
 * is a manual revision layered on the original anchor, not a fresh estimate.
 *
 * Same effective_from (today, 2026-09-19) as the original row -- this
 * upserts the SAME (title_id, platform, effective_from) key via
 * ON CONFLICT DO UPDATE, so it revises today's already-seeded row in place
 * rather than creating a second competing row for the same day.
 *
 * FORWARD-PROJECTION CAVEAT (unchanged from the original seed): the LTD
 * accumulator's "override anchors are a floor, not a ceiling" resolver
 * (commit 7a4b54e) means this multiplier is applied flatly to each future
 * day's cumulative signal. See
 * sentimentpulse/tasks/ps5-fresh-launch-multiplier-generalization.md for the
 * related PS5-exclusive generalization finding.
 *
 * Idempotent per (title_id, platform, effective_from). Resolves title_id
 * from a name-match query, refusing on ambiguity (same pattern as the
 * original seed script).
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

interface OverrideSeed {
  nameLike: string;
  platform: string;
  multiplier: number;
  ci_pct: number;
  digital_unit_share: number;
  confidence: string;
  method: string;
  notes: string;
  source_url: string;
}

const ORIGINAL_MULTIPLIER = 57.7;
const REVISED_MULTIPLIER = Math.round(ORIGINAL_MULTIPLIER * 0.85 * 1000) / 1000; // 49.045

const SEEDS: OverrideSeed[] = [
  {
    nameLike: "wolverine",
    platform: "ps5",
    multiplier: REVISED_MULTIPLIER,
    ci_pct: 0.40,
    digital_unit_share: 0.76,
    confidence: "analyst-estimate",
    method: "alinea_analytics_3day_estimate_2026_09_18_revised_minus15pct",
    notes:
      `Revises the same-day original seed (57.7x, Alinea Analytics 1.9M-units-in-3-days ` +
      `anchor) down 15% per explicit user direction on 2026-09-19, following initial ` +
      `deploy/verification of the 57.7x override. Revised multiplier = 57.7 x 0.85 = ` +
      `${REVISED_MULTIPLIER}x. ci_pct (0.40), digital_unit_share (0.76), and confidence ` +
      `("analyst-estimate") unchanged -- only the multiplier is cut. This is a manual ` +
      `conservatism adjustment layered on the existing analyst-estimate anchor, not a new ` +
      `independent calibration or a new source. Same forward-projection caveat applies: ` +
      `estimate-console-units.ts applies this multiplier flatly to each future day's ` +
      `cumulative signal (LTD-accumulator override-floor resolver, commit 7a4b54e). See ` +
      `sentimentpulse/tasks/ps5-fresh-launch-multiplier-generalization.md.`,
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

  console.log(`Revising ${SEEDS.length} per-title multiplier override(s) as of ${asOf} (-15% adjustment)`);

  let seeded = 0, skipped = 0;

  for (const seed of SEEDS) {
    console.log(`\n[${seed.nameLike} / ${seed.platform}] multiplier=${ORIGINAL_MULTIPLIER} -> ${seed.multiplier} (-15%)`);
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
    console.log(`Next: rerun scripts/estimate-console-units.ts to rebuild window_estimates_daily with the revised override.`);
  }
}

main();
