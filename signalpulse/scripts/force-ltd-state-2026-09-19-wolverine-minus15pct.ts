/**
 * Force Marvel's Wolverine (PS5) title_ltd_state.ltd_units down to match the
 * -15% multiplier revision, bypassing the LTD accumulator's "override
 * anchors are a floor, not a ceiling" resolver for this one title/day.
 *
 * BACKGROUND: revise-title-multiplier-override-2026-09-19-wolverine-minus15pct.ts
 * (merged same day) correctly cut the stored multiplier override from 57.7x
 * to 49.045x (-15%). But rerunning estimate-console-units.ts afterward left
 * title_ltd_state.ltd_units UNCHANGED at 2,688,061 (tagged
 * `override_floor_exceeded`), because Regime 1 of the LTD accumulator
 * (commit 7a4b54e) computes:
 *
 *     newLtdUnits = max(new_anchor_from_current_multiplier, existing_state, ...)
 *
 * The new anchor from the revised 49.045x multiplier (~2,284,852) is LOWER
 * than the existing stored state (2,688,061, set by the original 57.7x
 * override) -- so the max() picked the higher prior value and the visible
 * number never moved, even though the multiplier itself is correctly
 * revised in title_multiplier_overrides.
 *
 * Per explicit user direction on 2026-09-19 ("Force the stored value down"),
 * this script directly resets title_ltd_state for Wolverine/PS5 to the
 * anchor implied by the REVISED multiplier, bypassing the floor for this
 * one title/day only. This is a deliberate, explicit exception to the
 * floor's normal "never decrease" behavior -- not a change to the
 * accumulator logic itself, which is left completely untouched for every
 * other title.
 *
 * Anchor formula (mirrors estimate-console-units.ts Regime 1, confirmed by
 * matching the original 57.7x override's live output exactly:
 * 35,406 * 57.7 = 2,042,926.2 -> ownersMid=2,042,926;
 * 2,042,926 / 0.76 = 2,688,060.5 -> unitsMid=2,688,061 rounds the same way):
 *
 *     owners_new = rating_count_current * revised_multiplier
 *     units_new  = round(owners_new / digital_unit_share)
 *
 * rating_count is read LIVE from store_rating_signal_daily at run time
 * (not hardcoded), so this reflects whatever the latest captured signal is
 * when the workflow actually runs.
 *
 * After this force-write, the NEXT rerun of estimate-console-units.ts on
 * the same day's signal will compute the same anchor from the revised
 * multiplier and find it equal to (not exceeding) the just-forced state, so
 * it stays stable at the revised, lower value. Future organic signal growth
 * will still be free to raise the anchor above this floor as designed --
 * this script does not disable or weaken the floor mechanism, it only
 * corrects the one stale high-water mark left over from the original,
 * higher (57.7x) multiplier.
 *
 * Idempotent: re-running recomputes from the current live rating_count and
 * multiplier and writes the same deterministic result.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

const TITLE_ID = 10302; // Marvel's Wolverine
const PLATFORM = "ps5";

function main() {
  const nowIso = new Date().toISOString();

  // 1. Resolve the current revised multiplier + digital_unit_share for
  //    this title/platform from title_multiplier_overrides (most recent
  //    effective_from <= today).
  const override = rawSqlite.prepare(`
    SELECT multiplier, digital_unit_share, method, effective_from
      FROM title_multiplier_overrides
     WHERE title_id = ? AND platform = ?
       AND effective_from <= date('now')
     ORDER BY effective_from DESC
     LIMIT 1
  `).get(TITLE_ID, PLATFORM) as
    | { multiplier: number; digital_unit_share: number; method: string; effective_from: string }
    | undefined;

  if (!override) {
    console.error(`ERR: no active title_multiplier_overrides row found for title_id=${TITLE_ID} platform=${PLATFORM} -- aborting.`);
    process.exit(1);
  }

  console.log(`Active override: multiplier=${override.multiplier} digital_unit_share=${override.digital_unit_share} method="${override.method}" effective_from=${override.effective_from}`);

  // 2. Read the CURRENT live rating_count signal (most recent capture_date).
  const signal = rawSqlite.prepare(`
    SELECT rating_count, capture_date
      FROM store_rating_signal_daily
     WHERE title_id = ? AND platform = ?
     ORDER BY capture_date DESC
     LIMIT 1
  `).get(TITLE_ID, PLATFORM) as { rating_count: number; capture_date: string } | undefined;

  if (!signal) {
    console.error(`ERR: no store_rating_signal_daily row found for title_id=${TITLE_ID} platform=${PLATFORM} -- aborting.`);
    process.exit(1);
  }

  console.log(`Current signal: rating_count=${signal.rating_count} (captured ${signal.capture_date})`);

  // 3. Compute the anchor implied by the REVISED multiplier against the
  //    current live signal.
  const ownersNew = signal.rating_count * override.multiplier;
  const unitsNew = Math.round(ownersNew / override.digital_unit_share);

  console.log(`Computed revised anchor: owners=${Math.round(ownersNew)} units=${unitsNew}`);

  // 4. Read the existing title_ltd_state row for comparison/logging.
  const before = rawSqlite.prepare(`
    SELECT ltd_units, ltd_source, last_signal_value, last_updated_iso
      FROM title_ltd_state
     WHERE title_id = ? AND platform = ?
  `).get(TITLE_ID, PLATFORM) as
    | { ltd_units: number; ltd_source: string; last_signal_value: number; last_updated_iso: string }
    | undefined;

  if (!before) {
    console.error(`ERR: no existing title_ltd_state row for title_id=${TITLE_ID} platform=${PLATFORM} -- refusing to create one from this script (expected the estimator to have already seeded it).`);
    process.exit(1);
  }

  console.log(`Before: ltd_units=${before.ltd_units} ltd_source="${before.ltd_source}" last_signal_value=${before.last_signal_value} last_updated_iso=${before.last_updated_iso}`);

  if (unitsNew >= before.ltd_units) {
    console.log(`\nComputed revised anchor (${unitsNew}) is NOT lower than the existing stored value (${before.ltd_units}) -- nothing to force down. No change made.`);
    process.exit(0);
  }

  // 5. Force the value down. Tag ltd_source distinctly so the audit trail
  //    shows this was a manual, explicit floor override -- not a normal
  //    accumulator resolution.
  const result = rawSqlite.prepare(`
    UPDATE title_ltd_state
       SET ltd_units = ?,
           ltd_source = 'override_anchor_forced_revision',
           last_signal_value = ?,
           last_updated_iso = ?
     WHERE title_id = ? AND platform = ?
  `).run(unitsNew, signal.rating_count, nowIso, TITLE_ID, PLATFORM);

  console.log(`\n✓ Forced ltd_units: ${before.ltd_units} -> ${unitsNew} (rows changed: ${result.changes})`);
  console.log(`Next: rerun scripts/estimate-console-units.ts to rebuild window_estimates_daily and confirm the resolver reports the new value stably (should resolve to ltd_source="override_anchor", equal to this forced value, since anchor == existing_state now).`);
}

main();
