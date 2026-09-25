import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { reviewWindow, type ReviewBucket } from "./steam-review-windows";

type DB = Database.Database;
export const REPAIR_VERSION = "steam-overlap-state-v1";
type State = {
  title_id: number; platform: string; ltd_units: number; ltd_source: string;
  last_signal_value: number | null; last_updated_iso: string; seeded_from: string | null;
};
export type RepairEntry = {
  titleId: number; name: string; appId: string | null; status: "repair" | "skip";
  reason: string; before: State; after?: State; evidence?: Record<string, unknown>;
};
export type RepairPlan = { version: string; asOfDate: string; entries: RepairEntry[]; sha256: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read-only audit. No migrations, imports of storage.ts, or writes. */
export function planSteamLtdRepair(db: DB, asOfDate: string): RepairPlan {
  const now = `${asOfDate}T23:59:59.999Z`;
  // Validate the date even with an empty database.
  reviewWindow([], asOfDate, 7);
  const states = db.prepare("SELECT * FROM title_ltd_state WHERE platform='steam' ORDER BY title_id").all() as State[];
  const multiplier = db.prepare(`SELECT * FROM ownership_multipliers WHERE platform='steam'
    AND cohort_key='default' AND effective_from<=? ORDER BY effective_from DESC LIMIT 1`).get(now) as any;
  const historicalMultiplier = db.prepare("SELECT * FROM ownership_multipliers WHERE id=?");
  const entries = states.map(before => {
    const titleId = before.title_id;
    const identity = db.prepare(`SELECT name,store_name,release_date,store_release_date,match_confidence
      FROM console_title_igdb WHERE title_id=?`).get(titleId) as any;
    const maps = db.prepare(`SELECT DISTINCT external_sku FROM platform_sku_map
      WHERE title_id=? AND platform='steam' AND sku_role='base' AND business_model='paid'`).all(titleId) as any[];
    const e: RepairEntry = { titleId, name: identity?.store_name ?? identity?.name ?? String(titleId),
      appId: maps.length === 1 ? maps[0].external_sku : null, status: "skip", reason: "", before };
    const skip = (reason: string) => ({ ...e, reason });
    if (!Number.isFinite(before.ltd_units) || before.ltd_units < 0) return skip("invalid_state");
    if (before.ltd_source !== "derived_max_windows") return skip("protected_accumulator_or_override_state");
    if (!e.appId) return skip("ambiguous_or_missing_paid_base_app");
    if (db.prepare("SELECT 1 FROM revenue_calibration_anchors WHERE title_id=? LIMIT 1").get(titleId) ||
      db.prepare("SELECT 1 FROM title_multiplier_overrides WHERE title_id=? LIMIT 1").get(titleId) ||
      db.prepare("SELECT 1 FROM platform_sku_map WHERE title_id=? AND is_manual_override=1 LIMIT 1").get(titleId)) {
      return skip("protected_anchor_or_manual_override");
    }
    const release = identity?.match_confidence === "low" ? identity?.store_release_date :
      identity?.release_date ?? identity?.store_release_date;
    const age = (Date.parse(asOfDate) - Date.parse(release)) / 86400000;
    if (!Number.isFinite(age) || age < 0 || age >= 366) return skip("unknown_or_mature_release");
    if (!multiplier || !Number.isFinite(multiplier.multiplier) || !(multiplier.multiplier > 0) ||
      !Number.isFinite(multiplier.digital_unit_share) || !(multiplier.digital_unit_share > 0)) return skip("missing_multiplier");
    const snapshot = db.prepare(`SELECT * FROM store_rating_signal_daily WHERE title_id=? AND platform='steam'
      AND capture_date<=? ORDER BY capture_date DESC LIMIT 1`).get(titleId, asOfDate) as any;
    if (!snapshot || !Number.isSafeInteger(snapshot.rating_count) || snapshot.rating_count < 0 ||
      Date.parse(asOfDate) - Date.parse(snapshot.capture_date) > 2 * 86400000) return skip("missing_or_stale_snapshot");
    const buckets = db.prepare(`SELECT * FROM steam_review_history WHERE app_id=?`).all(e.appId) as ReviewBucket[];
    let grain: string | undefined;
    try { grain = JSON.parse(snapshot.raw_json ?? "{}").rollup_type; } catch { /* deterministic auto-selection */ }
    const histogram = reviewWindow(buckets, snapshot.capture_date.slice(0, 10), null, grain);
    if (!histogram.discardedOverlaps || histogram.signal !== snapshot.rating_count) return skip("unreconciled_or_nonoverlapping_histogram");
    const history = db.prepare(`SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam'
      AND as_of_date<=? AND gated_reason IS NULL ORDER BY as_of_date,window`).all(titleId, asOfDate) as any[];
    const ltd = history.filter(r => r.window === "ltd" && r.units_mid != null && r.signal_value != null);
    if (!ltd.length) return skip("missing_lifetime_provenance");
    const stateHistory = ltd.filter(r => String(r.method).includes("ltd_state:derived_max_windows"));
    if (!stateHistory.length ||
      Math.abs(Math.max(...stateHistory.map(r => r.units_mid)) - before.ltd_units) > 1) {
      return skip("state_not_explained_by_saved_history");
    }
    let safeFloor = Math.round(snapshot.rating_count * multiplier.multiplier / multiplier.digital_unit_share);
    let provenInflated = false;
    const invalidWindows: Array<{ date: string; window: string; signal: number; lifetimeSignal: number }> = [];
    for (const row of ltd) {
      if (!Number.isFinite(row.units_mid) || row.units_mid < 0 ||
        !Number.isSafeInteger(row.signal_value) || row.signal_value < 0) return skip("invalid_historical_evidence");
      const m = historicalMultiplier.get(row.multiplier_id) as any;
      if (!m || !Number.isFinite(m.digital_unit_share) || !(m.digital_unit_share > 0) ||
        !Number.isFinite(m.multiplier) || !(m.multiplier > 0)) return skip("unknown_historical_multiplier");
      const naive = Math.round(row.signal_value * m.multiplier / m.digital_unit_share);
      // These are unanchored MODEL states, not observed unit sales. Rebase
      // demonstrated overlap contamination at the unchanged ACTIVE coefficient.
      // Preserve the highest observed lifetime review count (including genuine
      // count resets), not a superseded coefficient's larger unit prediction.
      safeFloor = Math.max(safeFloor,
        Math.round(row.signal_value * multiplier.multiplier / multiplier.digital_unit_share));
      if (row.units_mid <= naive + 1) continue;
      if (!String(row.method).includes("ltd_state:derived_max_windows")) return skip("unexplained_historical_lifetime_method");
      const witnesses = history.filter(w => w.as_of_date === row.as_of_date && w.window !== "ltd" &&
        w.signal_value > row.signal_value && w.multiplier_id === row.multiplier_id &&
        !String(w.method).startsWith("override:") &&
        Math.abs(Math.round(w.signal_value * m.multiplier / m.digital_unit_share) - w.units_mid) <= 1 &&
        Math.abs(w.units_mid - row.units_mid) <= 1);
      if (!witnesses.length) {
        // A held maximum may carry forward from an earlier proven bad window.
        const earlier = ltd.filter(r => r.as_of_date < row.as_of_date && Math.abs(r.units_mid - row.units_mid) <= 1);
        if (!earlier.length) return skip("unexplained_historical_lifetime_maximum");
      } else {
        provenInflated = true;
        invalidWindows.push(...witnesses.map(w => ({
          date: w.as_of_date, window: w.window, signal: w.signal_value, lifetimeSignal: row.signal_value,
        })));
      }
    }
    if (!provenInflated) return skip("no_proven_overlap_inflation");
    if (safeFloor >= before.ltd_units - 1) return skip("legitimate_historical_maximum_retained");
    const after: State = { ...before, ltd_units: safeFloor, last_signal_value: snapshot.rating_count,
      seeded_from: REPAIR_VERSION };
    return { ...e, status: "repair" as const, reason: "proven_impossible_window_maximum", after,
      evidence: { histogram, snapshotDate: snapshot.capture_date, snapshotReviews: snapshot.rating_count,
        multiplier: multiplier.multiplier, digitalShare: multiplier.digital_unit_share,
        safeHistoricalFloor: safeFloor, policy: "active_coefficient_highest_observed_lifetime_signal",
        invalidWindows } };
  });
  const body = { version: REPAIR_VERSION, asOfDate, entries };
  return { ...body, sha256: hash(body) };
}

function ensureAudit(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS steam_overlap_repair_audit (
    run_id TEXT NOT NULL,title_id INTEGER NOT NULL,version TEXT NOT NULL,plan_sha256 TEXT NOT NULL,
    before_json TEXT NOT NULL,after_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
    applied_at TEXT NOT NULL,rolled_back_at TEXT,PRIMARY KEY(run_id,title_id));`);
}
function writeState(db: DB, s: State) {
  db.prepare(`UPDATE title_ltd_state SET ltd_units=?,ltd_source=?,last_signal_value=?,
    last_updated_iso=?,seeded_from=? WHERE title_id=? AND platform='steam'`).run(
      s.ltd_units, s.ltd_source, s.last_signal_value, s.last_updated_iso, s.seeded_from, s.title_id);
}
/** Explicit operator action. Replan inside the write lock; stale approvals abort. */
export function applySteamLtdRepair(db: DB, approved: RepairPlan, runId: string, stamp = new Date().toISOString()) {
  return db.transaction(() => {
    const fresh = planSteamLtdRepair(db, approved.asOfDate);
    if (fresh.sha256 !== approved.sha256) throw new Error("Repair plan changed; rerun dry-run and review the new manifest");
    ensureAudit(db);
    const repairs = fresh.entries.filter(e => e.status === "repair");
    for (const e of repairs) {
      const after = { ...e.after!, last_updated_iso: stamp };
      db.prepare(`INSERT INTO steam_overlap_repair_audit
        (run_id,title_id,version,plan_sha256,before_json,after_json,evidence_json,applied_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(runId, e.titleId, REPAIR_VERSION, fresh.sha256,
          JSON.stringify(e.before), JSON.stringify(after), JSON.stringify(e.evidence), stamp);
      writeState(db, after);
    }
    return { runId, repaired: repairs.length };
  }).immediate();
}
/** Scoped rollback only; never overwrite intervening estimator observations. */
export function rollbackSteamLtdRepair(db: DB, runId: string, stamp = new Date().toISOString()) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM steam_overlap_repair_audit WHERE run_id=?
      AND rolled_back_at IS NULL ORDER BY title_id`).all(runId) as any[];
    if (!rows.length) throw new Error("No applied repair rows for this run");
    for (const row of rows) {
      const state = db.prepare("SELECT * FROM title_ltd_state WHERE title_id=? AND platform='steam'").get(row.title_id);
      if (JSON.stringify(state) !== row.after_json) throw new Error(`State changed for ${row.title_id}; refusing destructive rollback`);
    }
    for (const row of rows) {
      writeState(db, JSON.parse(row.before_json));
      db.prepare("UPDATE steam_overlap_repair_audit SET rolled_back_at=? WHERE run_id=? AND title_id=?")
        .run(stamp, runId, row.title_id);
    }
    return { runId, restored: rows.length };
  }).immediate();
}
