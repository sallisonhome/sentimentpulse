/* Per-title multiplier override for Samson - A Tyndalston Story on Xbox (title 11202), plus a one-time lowering of
 * the stale title_ltd_state high-water mark to the override anchor (override anchors are a floor in the LTD
 * accumulator, so the state would otherwise keep 154,350). Dry run by default; APPLY=1 writes.
 *
 * Basis (all of it estimates, stated plainly): same game, same launch day, same $24.99 as PS5. PS5 runs 24 owners
 * per rating (1,505 ratings). Across 15 cross-platform catalog pairs with >=300 ratings on both consoles, Xbox
 * units per rating are a median 1.97x PS5's (IQR 1.11 to 5.1). Xbox override = 24 x 1.97 x (0.9 / 0.76) rounded to 56
 * owners per rating at the Xbox digital share 0.9, i.e. about 62 units per rating versus 147 x 1.406 / 0.9 = 230 before.
 * Overrides only the multiplier for this title; native PS5 and Steam rows are untouched. */
import { rawSqlite } from "../server/storage";

const TITLE_ID = 11202, PLATFORM = "xbox";
const MULT = 56, SHARE = 0.9, CI = 0.75, FROM = "2026-10-03";
const apply = process.env.APPLY === "1";

const sig = rawSqlite.prepare(`SELECT rating_count, capture_date FROM store_rating_signal_daily WHERE title_id=? AND platform=? ORDER BY capture_date DESC LIMIT 1`).get(TITLE_ID, PLATFORM) as any;
const st = rawSqlite.prepare(`SELECT * FROM title_ltd_state WHERE title_id=? AND platform=?`).get(TITLE_ID, PLATFORM) as any;
const ov = rawSqlite.prepare(`SELECT * FROM title_multiplier_overrides WHERE title_id=? AND platform=?`).all(TITLE_ID, PLATFORM);
if (!sig || !st) { console.error("ERR: missing signal or state row"); process.exit(1); }
const anchorUnits = Math.round(sig.rating_count * MULT / SHARE);
console.log("existing overrides", JSON.stringify(ov)); console.log("signal", JSON.stringify(sig)); console.log("state", JSON.stringify(st));
console.log(`override ${MULT} owners/rating, share ${SHARE}, ci ${CI}; anchor units = ${anchorUnits}`);
console.log(anchorUnits < st.ltd_units ? `state would be lowered ${st.ltd_units} -> ${anchorUnits}` : "state already at or below anchor; no state change");
if (!apply) { console.log("DRY RUN: nothing written"); process.exit(0); }
const now = new Date().toISOString();
rawSqlite.prepare(`INSERT INTO title_multiplier_overrides (title_id,platform,multiplier,ci_pct,digital_unit_share,confidence,method,notes,source_url,effective_from,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (title_id,platform,effective_from) DO UPDATE SET multiplier=excluded.multiplier,ci_pct=excluded.ci_pct,digital_unit_share=excluded.digital_unit_share,method=excluded.method,notes=excluded.notes`)
  .run(TITLE_ID, PLATFORM, MULT, CI, SHARE, "derived-sibling-ratio", "ps5_sibling_units_per_rating_x_catalog_xbox_ratio_v1",
    "Samson Xbox: platform multiplier (147x1.406 GP deflator) gave 311,931 units on 315 ratings vs PS5 47,526 on 1,505. Override = PS5 owners/rating 24 x catalog median Xbox/PS5 units-per-rating 1.97 (15 pairs) adjusted for digital share. Estimate, not a disclosure.", null, FROM, now);
if (anchorUnits < st.ltd_units) {
  const r = rawSqlite.prepare(`UPDATE title_ltd_state SET ltd_units=?, ltd_source='override_anchor_forced_revision', last_signal_value=?, last_updated_iso=? WHERE title_id=? AND platform=? AND ltd_units=?`)
    .run(anchorUnits, sig.rating_count, now, TITLE_ID, PLATFORM, st.ltd_units);
  console.log(`state rows=${r.changes}; rollback: UPDATE title_ltd_state SET ltd_units=${st.ltd_units}, ltd_source='${st.ltd_source}' WHERE title_id=${TITLE_ID} AND platform='${PLATFORM}'`);
}
console.log(`override rollback: DELETE FROM title_multiplier_overrides WHERE title_id=${TITLE_ID} AND platform='${PLATFORM}' AND effective_from='${FROM}'`);
