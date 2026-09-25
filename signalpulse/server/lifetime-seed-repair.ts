import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { reviewWindow, type ReviewBucket } from "./steam-review-windows";

type DB = Database.Database;
type Row = Record<string, any>;
export const SEED_REPAIR_VERSION = "steam-initial-snapshot-seed-v1";
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const query = (db: DB, sql: string, ...args: any[]) => db.prepare(sql).all(...args) as Row[];

/**
 * A narrow, read-only provenance proof, not a revenue cap or multiplier refit.
 * Repair only an unanchored legacy accumulator whose exact initial jump is
 * explained by an isolated, corrected first snapshot. Unknown histories fail closed.
 */
export function planLifetimeSeedRepair(db: DB, asOf: string) {
  reviewWindow([], asOf, 7);
  const entries = query(db, "SELECT * FROM title_ltd_state ORDER BY title_id,platform").map(before => {
    const id = before.title_id;
    const meta = db.prepare("SELECT * FROM console_title_igdb WHERE title_id=?").get(id) as Row | undefined;
    const entry = { titleId: id, platform: before.platform, name: meta?.store_name ?? meta?.name,
      before, status: "skip", reason: "" };
    const skip = (reason: string) => ({ ...entry, reason });
    if (before.platform !== "steam" || before.ltd_source !== "accumulator" ||
      !/^option_b_replay_\d{4}_\d{2}_\d{2}$/.test(before.seeded_from ?? "")) return skip("not_legacy_steam_accumulator");
    if (db.prepare("SELECT 1 FROM revenue_calibration_anchors WHERE title_id=?").get(id) ||
      db.prepare("SELECT 1 FROM title_multiplier_overrides WHERE title_id=?").get(id) ||
      db.prepare("SELECT 1 FROM platform_sku_map WHERE title_id=? AND is_manual_override=1").get(id))
      return skip("protected_anchor_or_override");
    const maps = query(db, "SELECT DISTINCT external_sku FROM platform_sku_map WHERE title_id=? AND platform='steam' AND sku_role='base' AND business_model='paid'", id);
    if (maps.length !== 1) return skip("ambiguous_identity");
    const snapshots = query(db, "SELECT * FROM store_rating_signal_daily WHERE title_id=? AND platform='steam' AND capture_date<=? ORDER BY capture_date", id, asOf);
    const first = snapshots[0], corrected = snapshots[1], latest = snapshots.at(-1);
    // The threshold only nominates a candidate. Exact seed arithmetic and all
    // subsequent persisted estimates must independently prove the excess.
    if (!first || !corrected || !latest || snapshots.length < 5 ||
      !(first.rating_count > corrected.rating_count * 10) ||
      snapshots.slice(1).some(r => !(r.rating_count >= corrected.rating_count) || r.rating_count >= first.rating_count / 10))
      return skip("no_isolated_initial_snapshot_correction");
    if (Date.parse(asOf) - Date.parse(latest.capture_date) > 2 * 86400000) return skip("stale_snapshot");
    const buckets = query(db, "SELECT * FROM steam_review_history WHERE app_id=?", maps[0].external_sku) as ReviewBucket[];
    let grain; try { grain = JSON.parse(latest.raw_json ?? "{}").rollup_type; } catch {}
    if (reviewWindow(buckets, latest.capture_date, null, grain).signal !== latest.rating_count)
      return skip("snapshot_histogram_mismatch");
    const history = query(db, "SELECT * FROM window_estimates_daily WHERE title_id=? AND platform='steam' AND window='ltd' AND as_of_date<=? ORDER BY as_of_date", id, asOf);
    const seedDate = before.seeded_from.slice("option_b_replay_".length).replaceAll("_", "-");
    const seed = history.find(r => r.as_of_date === seedDate);
    const prior = history.filter(r => r.as_of_date < seedDate);
    if (!seed || prior.length < 3 || prior.some(r => r.gated_reason || !Number.isFinite(r.signal_value) ||
      r.signal_value < corrected.rating_count || r.signal_value >= first.rating_count / 10 ||
      String(r.method).includes("ltd_state:") || String(r.method).startsWith("override:")))
      return skip("missing_clean_preseed_history");
    const mult = db.prepare("SELECT * FROM ownership_multipliers WHERE id=?").get(seed.multiplier_id) as Row | undefined;
    const active = db.prepare("SELECT * FROM ownership_multipliers WHERE platform='steam' AND cohort_key='default' AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(asOf+"T23:59:59Z") as Row | undefined;
    if (!mult || mult.id !== active?.id || !(mult.multiplier > 0) || !(mult.digital_unit_share > 0))
      return skip("coefficient_changed");
    const coefficient = mult.multiplier / mult.digital_unit_share;
    const seedSnapshots = snapshots.filter(r => r.capture_date <= seedDate);
    if (seedSnapshots.at(-1)?.rating_count !== seed.signal_value) return skip("seed_snapshot_mismatch");
    let legacySignal = first.rating_count;
    for (let i=1; i<seedSnapshots.length; i++) legacySignal += Math.max(0, seedSnapshots[i].rating_count-seedSnapshots[i-1].rating_count);
    const expectedSeed = Math.round(legacySignal * coefficient);
    const cleanSeed = Math.round(seed.signal_value * coefficient);
    if (seed.units_mid !== expectedSeed || expectedSeed <= cleanSeed ||
      prior.at(-1)!.multiplier_id !== mult.id ||
      Math.abs(prior.at(-1)!.units_mid - Math.round(prior.at(-1)!.signal_value * coefficient)) > 1)
      return skip("unproven_seed_arithmetic");
    const subsequent = history.filter(r => r.as_of_date >= seedDate);
    for (let i=0; i<subsequent.length; i++) {
      const row = subsequent[i], prev = subsequent[i-1];
      if (row.gated_reason || row.multiplier_id !== mult.id ||
        !Number.isSafeInteger(row.signal_value) || row.signal_value < 0 ||
        !String(row.method).endsWith("+ltd_state:accumulator") ||
        !Number.isSafeInteger(row.units_mid) ||
        (prev && (row.signal_value < prev.signal_value ||
          Math.abs(row.units_mid - Math.round(prev.units_mid+(row.signal_value-prev.signal_value)*coefficient)) > 1)))
        return skip("unexplained_postseed_history");
    }
    const last = subsequent.at(-1)!;
    if (last.units_mid !== before.ltd_units || last.signal_value !== before.last_signal_value ||
      last.signal_value !== latest.rating_count) return skip("state_history_mismatch");
    const excess = expectedSeed - cleanSeed;
    // Subtract only the proven seed excess; retain each subsequent increment
    // (including historical rounding) instead of inventing a new sales history.
    const estimateChanges = subsequent.map(row => {
      const units = row.units_mid-excess, scale = units/row.units_mid;
      return { before: row, after: { ...row, units_mid: units,
        owners_mid: row.owners_mid == null ? null : Math.round(row.owners_mid*scale),
        owners_low: row.owners_low == null ? null : Math.round(row.owners_low*scale),
        owners_high: row.owners_high == null ? null : Math.round(row.owners_high*scale),
        method: row.method+"+seed_repaired_v1" } };
    });
    return { ...entry, status: "repair", reason: "proven_initial_snapshot_seed_excess",
      after: { ...before, ltd_units: before.ltd_units-excess, seeded_from: SEED_REPAIR_VERSION },
      estimateChanges, evidence: { appId: maps[0].external_sku, firstDate: first.capture_date,
        firstSignal: first.rating_count, correctedDate: corrected.capture_date,
        correctedSignal: corrected.rating_count, latestSignal: latest.rating_count,
        seedDate, expectedSeed, cleanSeed, excess, multiplierId: mult.id, coefficient,
        histogramSignal: latest.rating_count } };
  });
  const body = { version: SEED_REPAIR_VERSION, asOf, entries };
  return { ...body, sha256: hash(body) };
}
export type SeedRepairPlan = ReturnType<typeof planLifetimeSeedRepair>;

function writeState(db: DB, r: Row) {
  db.prepare("UPDATE title_ltd_state SET ltd_units=?,ltd_source=?,last_signal_value=?,last_updated_iso=?,seeded_from=? WHERE title_id=? AND platform=?")
    .run(r.ltd_units,r.ltd_source,r.last_signal_value,r.last_updated_iso,r.seeded_from,r.title_id,r.platform);
}
function writeEstimate(db: DB, r: Row) {
  db.prepare("UPDATE window_estimates_daily SET units_mid=?,owners_mid=?,owners_low=?,owners_high=?,method=? WHERE id=?")
    .run(r.units_mid,r.owners_mid,r.owners_low,r.owners_high,r.method,r.id);
}
export function applyLifetimeSeedRepair(db: DB, approved: SeedRepairPlan, runId: string) {
  return db.transaction(() => {
    const fresh = planLifetimeSeedRepair(db, approved.asOf);
    const { sha256, ...body } = approved;
    if (hash(body) !== sha256 || fresh.sha256 !== sha256) throw Error("Repair plan changed");
    db.exec(`CREATE TABLE IF NOT EXISTS lifetime_seed_repair_audit(
      run_id TEXT NOT NULL,title_id INTEGER NOT NULL,platform TEXT NOT NULL,plan_sha TEXT NOT NULL,
      change_json TEXT NOT NULL,applied_at TEXT NOT NULL,rolled_back_at TEXT,
      PRIMARY KEY(run_id,title_id,platform))`);
    const repairs = fresh.entries.filter(e => e.status === "repair");
    for (const e of repairs) {
      if (!("after" in e) || !("estimateChanges" in e)) throw Error("Missing repair evidence");
      const change = { ...e, after: { ...e.after, last_updated_iso: new Date().toISOString() } };
      db.prepare("INSERT INTO lifetime_seed_repair_audit VALUES(?,?,?,?,?,?,NULL)")
        .run(runId,e.titleId,e.platform,fresh.sha256,JSON.stringify(change),new Date().toISOString());
      writeState(db, change.after);
      for (const row of e.estimateChanges) writeEstimate(db, row.after);
    }
    return { runId, repaired: repairs.length };
  }).immediate();
}
export function rollbackLifetimeSeedRepair(db: DB, runId: string) {
  return db.transaction(() => {
    const rows = query(db,"SELECT * FROM lifetime_seed_repair_audit WHERE run_id=? AND rolled_back_at IS NULL",runId);
    if (!rows.length) throw Error("No active repair rows");
    const changes = rows.map(r=>JSON.parse(r.change_json));
    for (const e of changes) {
      const current = db.prepare("SELECT * FROM title_ltd_state WHERE title_id=? AND platform=?").get(e.titleId,e.platform);
      if (JSON.stringify(current)!==JSON.stringify(e.after)) throw Error("Intervening state write; refusing rollback");
      for (const row of e.estimateChanges) {
        const now = db.prepare("SELECT * FROM window_estimates_daily WHERE id=?").get(row.after.id);
        if (JSON.stringify(now)!==JSON.stringify(row.after)) throw Error("Intervening estimate write; refusing rollback");
      }
    }
    for (const e of changes) {
      writeState(db,e.before);
      for (const r of e.estimateChanges) writeEstimate(db,r.before);
    }
    db.prepare("UPDATE lifetime_seed_repair_audit SET rolled_back_at=? WHERE run_id=?")
      .run(new Date().toISOString(),runId);
    return { restored: rows.length, runId };
  }).immediate();
}
