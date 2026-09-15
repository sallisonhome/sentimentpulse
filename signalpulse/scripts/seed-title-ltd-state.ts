/**
 * seed-title-ltd-state.ts (2026-09-14)
 *
 * One-time seed of the title_ltd_state accumulator table. Reads the current
 * (title, platform) universe from window_estimates_daily, joins release date
 * from console_title_igdb, joins the active per-title override (if any) from
 * title_multiplier_overrides, and populates title_ltd_state per the three
 * regimes:
 *
 *   1. override_anchor      — a title_multiplier_overrides row exists.
 *                             ltd_units = today's derived LTD row from
 *                             window_estimates_daily (which already applied
 *                             the override multiplier).
 *   2. derived_max_windows  — age < 366d, no override. ltd_units =
 *                             max(units[d7], units[d30], units[d90],
 *                                 units[m12], units[ltd]).
 *   3. accumulator          — age >= 366d, no override. ltd_units =
 *                             OPTION B REPLAY: sum of
 *                               max(0, rating_count[day_n] - rating_count[day_n-1])
 *                                 * multiplier / digital_share
 *                             across all days in store_rating_signal_daily,
 *                             then max()'d with today's derived LTD.
 *                             (Monotonic guarantee at transition.)
 *
 * Idempotent: uses INSERT ... ON CONFLICT DO UPDATE. Safe to re-run.
 *
 * Dry-run mode: DRY_RUN=1 prints the proposed LTD for each of ~20 sample
 * titles across regime and platform, but does NOT write.
 *
 * Usage (via signalpulse-seed-ltd-state.yml workflow):
 *   DRY_RUN=1 tsx scripts/seed-title-ltd-state.ts   # preview
 *   tsx scripts/seed-title-ltd-state.ts             # commit
 */

import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), "data.db");
const DRY_RUN = process.env.DRY_RUN === "1";
const AS_OF = process.env.AS_OF ?? new Date().toISOString().slice(0, 10);

const db = new Database(DB_PATH, { readonly: DRY_RUN });
db.pragma("foreign_keys = ON");

type Regime = "override_anchor" | "derived_max_windows" | "accumulator";
type Row = {
  title_id: number;
  platform: string;
  regime: Regime;
  ltd_units: number;
  last_signal_value: number | null;
  age_days: number | null;
  ltd_before: number | null; // today's window_estimates_daily.ltd units_mid
  replay_total: number | null; // accumulator-only: raw Option B sum before max()
  windows: Record<string, number | null>; // d7..m12 units for audit
};

function daysBetween(a: string, b: string): number {
  const A = new Date(a + "T00:00:00Z").getTime();
  const B = new Date(b + "T00:00:00Z").getTime();
  return Math.floor((B - A) / 86400000);
}

// Universe: every (title_id, platform) with a row in window_estimates_daily
// for today. We seed all of them; if a title is orphaned in
// console_title_igdb it falls into the "no release_date" bucket below.
const universe = db
  .prepare(
    `SELECT DISTINCT title_id, platform
       FROM window_estimates_daily
      WHERE as_of_date = ?`,
  )
  .all(AS_OF) as Array<{ title_id: number; platform: string }>;

// Release date map (mirrors estimator's confidence-aware pick)
const releaseRows = db
  .prepare(
    `SELECT title_id,
            CASE WHEN match_confidence = 'low'
              THEN COALESCE(store_release_date, release_date)
              ELSE COALESCE(release_date, store_release_date)
            END AS effective_release
       FROM console_title_igdb`,
  )
  .all() as Array<{ title_id: number; effective_release: string | null }>;
const releaseByTitle = new Map<number, string>();
for (const r of releaseRows) {
  if (r.effective_release) releaseByTitle.set(r.title_id, r.effective_release);
}

// Active overrides map — the estimator writes today's LTD row through the
// override's method, so if a row exists we accept today's derived LTD as
// authoritative and mark the state 'override_anchor'.
const overrideRows = db
  .prepare(
    `SELECT title_id, platform
       FROM title_multiplier_overrides
      WHERE effective_from <= ?
      GROUP BY title_id, platform`,
  )
  .all(new Date().toISOString()) as Array<{ title_id: number; platform: string }>;
const overrideKeys = new Set(overrideRows.map((r) => `${r.title_id}|${r.platform}`));

// Today's window_estimates_daily as the source of derived unit values
const todayEstsRows = db
  .prepare(
    `SELECT title_id, platform, window, units_mid, signal_value
       FROM window_estimates_daily
      WHERE as_of_date = ?`,
  )
  .all(AS_OF) as Array<{
  title_id: number;
  platform: string;
  window: string;
  units_mid: number | null;
  signal_value: number | null;
}>;
const estByKey = new Map<string, Map<string, { units: number | null; signal: number | null }>>();
for (const e of todayEstsRows) {
  const key = `${e.title_id}|${e.platform}`;
  if (!estByKey.has(key)) estByKey.set(key, new Map());
  estByKey.get(key)!.set(e.window, { units: e.units_mid, signal: e.signal_value });
}

// Applied per-title multiplier + digital_share (override wins over platform default)
type Mult = { multiplier: number; digital_share: number; method: string };
const platformMult = new Map<string, Mult>();
for (const platform of ["steam", "xbox", "ps5"]) {
  const row = db
    .prepare(
      `SELECT platform, multiplier, digital_unit_share, method
         FROM ownership_multipliers
        WHERE platform = ? AND cohort_key = 'default'
          AND effective_from <= ?
        ORDER BY effective_from DESC
        LIMIT 1`,
    )
    .get(platform, new Date().toISOString()) as
    | { platform: string; multiplier: number; digital_unit_share: number; method: string }
    | undefined;
  if (row) {
    platformMult.set(platform, {
      multiplier: row.multiplier,
      digital_share: row.digital_unit_share,
      method: row.method,
    });
  }
}
const titleOverrideRows = db
  .prepare(
    `SELECT title_id, platform, multiplier, digital_unit_share, method
       FROM title_multiplier_overrides
      WHERE effective_from <= ?
      GROUP BY title_id, platform
      HAVING MAX(effective_from)`,
  )
  .all(new Date().toISOString()) as Array<{
  title_id: number;
  platform: string;
  multiplier: number;
  digital_unit_share: number;
  method: string;
}>;
const titleMult = new Map<string, Mult>();
for (const t of titleOverrideRows) {
  titleMult.set(`${t.title_id}|${t.platform}`, {
    multiplier: t.multiplier,
    digital_share: t.digital_unit_share,
    method: t.method,
  });
}
function multFor(titleId: number, platform: string): Mult | null {
  return titleMult.get(`${titleId}|${platform}`) ?? platformMult.get(platform) ?? null;
}

// Option B replay: sum positive daily deltas × multiplier / digital_share
// across the entire history in store_rating_signal_daily. Uses today's applied
// multiplier for every day (i.e. we don't try to reconstruct historical
// multipliers — the accumulator represents "if today's calibration had been
// used all along, this is what LTD would be"). Cheaper, and any future
// re-calibration is handled by a fresh seed pass.
function replayOptionB(titleId: number, platform: string): { total: number; days: number; last_signal: number | null } | null {
  const rows = db
    .prepare(
      `SELECT capture_date, rating_count
         FROM store_rating_signal_daily
        WHERE title_id = ? AND platform = ? AND rating_count IS NOT NULL
        ORDER BY capture_date ASC`,
    )
    .all(titleId, platform) as Array<{ capture_date: string; rating_count: number }>;
  if (rows.length === 0) return null;
  const m = multFor(titleId, platform);
  if (!m) return null;
  let sum = 0;
  let prev: number | null = null;
  for (const r of rows) {
    if (prev == null) {
      // First observed day — treat the entire snapshot as the starting delta.
      // This over-counts by whatever happened before we started collecting,
      // but for tenured titles the snapshot is a running total anyway so
      // "before-collection ratings" are already in there. The max() at the
      // end handles the case where this seed value is larger than the
      // current derived LTD.
      sum += r.rating_count;
    } else {
      const delta = r.rating_count - prev;
      if (delta > 0) sum += delta;
    }
    prev = r.rating_count;
  }
  const units = (sum * m.multiplier) / m.digital_share;
  return { total: Math.round(units), days: rows.length, last_signal: prev };
}

const rows: Row[] = [];
for (const { title_id, platform } of universe) {
  const key = `${title_id}|${platform}`;
  const rel = releaseByTitle.get(title_id) ?? null;
  const age = rel ? daysBetween(rel, AS_OF) : null;

  const ests = estByKey.get(key) ?? new Map();
  const ltd_row = ests.get("ltd");
  const ltd_before = ltd_row?.units ?? null;
  const wins: Record<string, number | null> = {
    d7: ests.get("d7")?.units ?? null,
    d30: ests.get("d30")?.units ?? null,
    d90: ests.get("d90")?.units ?? null,
    m12: ests.get("m12")?.units ?? null,
    ltd: ltd_before,
  };

  let regime: Regime;
  let ltd_units: number;
  let replay_total: number | null = null;
  let last_signal = ltd_row?.signal ?? null;

  if (overrideKeys.has(key)) {
    regime = "override_anchor";
    // Accept today's derived LTD (it was computed through the override
    // method). If missing for any reason, skip this title.
    if (ltd_before == null) continue;
    ltd_units = ltd_before;
  } else if (age == null || age < 366) {
    regime = "derived_max_windows";
    const vals = Object.values(wins).filter((v): v is number => v != null && v > 0);
    if (vals.length === 0) continue;
    ltd_units = Math.max(...vals);
  } else {
    regime = "accumulator";
    const replay = replayOptionB(title_id, platform);
    replay_total = replay?.total ?? null;
    const vals = Object.values(wins).filter((v): v is number => v != null && v > 0);
    const max_windows = vals.length > 0 ? Math.max(...vals) : 0;
    if (replay_total == null && max_windows === 0) continue;
    ltd_units = Math.max(replay_total ?? 0, max_windows);
    if (replay?.last_signal != null) last_signal = replay.last_signal;
  }

  rows.push({
    title_id,
    platform,
    regime,
    ltd_units,
    last_signal_value: last_signal,
    age_days: age,
    ltd_before,
    replay_total,
    windows: wins,
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────
const byRegime: Record<Regime, number> = {
  override_anchor: 0,
  derived_max_windows: 0,
  accumulator: 0,
};
for (const r of rows) byRegime[r.regime]++;

console.log(`[seed-title-ltd-state] as_of=${AS_OF} dry_run=${DRY_RUN}`);
console.log(`[seed-title-ltd-state] universe=${universe.length}, seeded=${rows.length}`);
console.log(`[seed-title-ltd-state]   override_anchor:      ${byRegime.override_anchor}`);
console.log(`[seed-title-ltd-state]   derived_max_windows:  ${byRegime.derived_max_windows}`);
console.log(`[seed-title-ltd-state]   accumulator:          ${byRegime.accumulator}`);

// ─── Sample dump: 5 rows per regime, one per platform ────────────────────
console.log("");
console.log("[seed-title-ltd-state] SAMPLE (per regime × platform):");
const seenSample = new Set<string>();
for (const regime of ["override_anchor", "derived_max_windows", "accumulator"] as Regime[]) {
  for (const platform of ["steam", "ps5", "xbox"]) {
    const bucket = rows.filter((r) => r.regime === regime && r.platform === platform).slice(0, 3);
    for (const r of bucket) {
      const k = `${r.title_id}|${r.platform}`;
      if (seenSample.has(k)) continue;
      seenSample.add(k);
      const wStr = Object.entries(r.windows)
        .map(([w, v]) => `${w}=${v ?? "null"}`)
        .join(" ");
      const delta = r.ltd_before != null ? Math.round(r.ltd_units - r.ltd_before) : "n/a";
      console.log(
        `  [${r.regime.padEnd(20)}][${r.platform.padEnd(5)}] title=${r.title_id.toString().padStart(6)} age=${(r.age_days ?? "n/a").toString().padStart(5)}d ltd_before=${(r.ltd_before ?? "null").toString().padStart(10)} ltd_after=${r.ltd_units.toString().padStart(10)} delta=${delta} windows: ${wStr}${r.replay_total != null ? ` replay=${r.replay_total}` : ""}`,
      );
    }
  }
}

if (DRY_RUN) {
  console.log("");
  console.log("[seed-title-ltd-state] DRY_RUN — no rows written. Re-run with DRY_RUN=0 to commit.");
  process.exit(0);
}

// ─── Commit ──────────────────────────────────────────────────────────────
const nowIso = new Date().toISOString();
const seededFrom = `option_b_replay_${AS_OF.replaceAll("-", "_")}`;
const upsert = db.prepare(
  `INSERT INTO title_ltd_state
     (title_id, platform, ltd_units, ltd_source, last_signal_value, last_updated_iso, seeded_from)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(title_id, platform) DO UPDATE SET
     ltd_units          = MAX(excluded.ltd_units, title_ltd_state.ltd_units),
     ltd_source         = excluded.ltd_source,
     last_signal_value  = excluded.last_signal_value,
     last_updated_iso   = excluded.last_updated_iso,
     seeded_from        = excluded.seeded_from`,
);
const tx = db.transaction((rs: Row[]) => {
  for (const r of rs) {
    upsert.run(r.title_id, r.platform, r.ltd_units, r.regime, r.last_signal_value, nowIso, seededFrom);
  }
});
tx(rows);
console.log(`[seed-title-ltd-state] wrote ${rows.length} rows to title_ltd_state (seeded_from=${seededFrom}).`);
