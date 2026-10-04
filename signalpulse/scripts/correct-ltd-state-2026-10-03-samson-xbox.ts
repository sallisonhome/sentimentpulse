/* Lower Samson - A Tyndalston Story (Xbox, title 11202) title_ltd_state to the largest window value.
 * Background and rule: server/ltd-state-cap-correction.ts and lessons.md (2026-10-03 rank-anchor). Default is a
 * dry run that prints before/after; set APPLY=1 to write (after a data.db backup in the workflow). */
import { rawSqlite } from "../server/storage";
import { correctedLtdUnits } from "../server/ltd-state-cap-correction";

const TITLE_ID = 11202, PLATFORM = "xbox";
const apply = process.env.APPLY === "1";
const asOf = (rawSqlite.prepare(`SELECT MAX(as_of_date) d FROM window_estimates_daily WHERE title_id=? AND platform=?`).get(TITLE_ID, PLATFORM) as any)?.d;
if (!asOf) { console.error("ERR: no window rows"); process.exit(1); }
const rows = rawSqlite.prepare(`SELECT window, units_mid, method, gated_reason FROM window_estimates_daily WHERE title_id=? AND platform=? AND as_of_date=?`).all(TITLE_ID, PLATFORM, asOf) as any[];
const st = rawSqlite.prepare(`SELECT * FROM title_ltd_state WHERE title_id=? AND platform=?`).get(TITLE_ID, PLATFORM) as any;
console.log("as_of", asOf); console.table(rows); console.log("state before", JSON.stringify(st));
if (!st) { console.error("ERR: no state row"); process.exit(1); }
const r = correctedLtdUnits(rows, st.ltd_units);
console.log("decision", JSON.stringify(r));
if (r.target == null) process.exit(0);
if (!apply) { console.log(`DRY RUN: would set ltd_units ${st.ltd_units} -> ${r.target}`); process.exit(0); }
const res = rawSqlite.prepare(`UPDATE title_ltd_state SET ltd_units=?, ltd_source='rank_anchor_cap_correction', last_updated_iso=? WHERE title_id=? AND platform=? AND ltd_units=?`)
  .run(r.target, new Date().toISOString(), TITLE_ID, PLATFORM, st.ltd_units);
console.log(`APPLIED rows=${res.changes}: ${st.ltd_units} -> ${r.target}. Rollback: UPDATE title_ltd_state SET ltd_units=${st.ltd_units}, ltd_source='${st.ltd_source}' WHERE title_id=${TITLE_ID} AND platform='${PLATFORM}'`);
