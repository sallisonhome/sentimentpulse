/**
 * Phase 4 v0 — write window_estimates_daily rows for every eligible (title, platform, window).
 *
 * Formula (per console_leaderboards_spec §5):
 *   signal(p, w)      = ratings added in window w on platform p
 *   owners_mid(p, w)  = signal(p, w) × multiplier(p, cohort)
 *   owners_low/high   = owners_mid × (1 ∓ ci_pct)
 *   units_mid(p, w)   = owners_mid / digital_unit_share(p)
 *
 * Signal sources (v0):
 *   Steam ltd  — store_rating_signal_daily.rating_count
 *   Steam d7/d30/d90/m12 — SUM(recommendations_up + recommendations_down) from
 *                          steam_review_history buckets ending in [now-N, now]
 *   Xbox ltd/d7/d30 — bundled into store_rating_signal_daily.raw_json.windows[]
 *                     (native from displaycatalog UsageData)
 *   PS5 ltd — store_rating_signal_daily.rating_count. d7/d30/d90 need
 *             forward-only day-over-day deltas; gated until ≥N days of history.
 *
 * Gates:
 *   'signal_too_small'      — signal < noise_gate (spec §6, default 50)
 *   'insufficient_history'  — window needs more days of collection than we have
 *   'no_multiplier'         — active multiplier row missing (should never happen after seed)
 *
 * v0 is CLEARLY LABELLED — confidence='v0-defaults' — and must be replaced by
 * a fitted set before boards leave internal-only state.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

const NOISE_GATE_DEFAULT = 50;

interface MultiplierRow {
  id: number;
  platform: string;
  cohort_key: string;
  multiplier: number;
  ci_pct: number;
  digital_unit_share: number;
  confidence: string;
  method: string;
}

type Window = "d7" | "d30" | "d90" | "m12" | "ltd";
const ALL_WINDOWS: Window[] = ["d7", "d30", "d90", "m12", "ltd"];
const WINDOW_DAYS: Record<Window, number | null> = {
  d7: 7, d30: 30, d90: 90, m12: 365, ltd: null,
};

interface EstimateRow {
  titleId: number;
  platform: string;
  window: Window;
  asOfDate: string;
  signalValue: number | null;
  ownersLow: number | null;
  ownersMid: number | null;
  ownersHigh: number | null;
  unitsMid: number | null;
  multiplierId: number | null;
  gatedReason: string | null;
  method: string;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function daysAgoEpochSec(days: number): number {
  return Math.floor((Date.now() - days * 86_400_000) / 1000);
}

async function main() {
  const db = rawSqlite;
  const asOfDate = isoDate();
  const nowIso = new Date().toISOString();

  // ─── 1. Noise gate from app_settings ─────────────────────────────────────
  const gateRow = db.prepare(
    `SELECT value FROM app_settings WHERE key = 'noise_gate_min_signal'`
  ).get() as { value: string } | undefined;
  const noiseGate = gateRow ? parseInt(gateRow.value, 10) : NOISE_GATE_DEFAULT;
  console.log(`[estimate-console-units] noise_gate_min_signal=${noiseGate}`);

  // ─── 2. Latest multiplier per (platform, cohort_key='default') ────────────
  const multipliers = new Map<string, MultiplierRow>();
  for (const platform of ["steam", "xbox", "ps5"]) {
    const row = db.prepare(
      `SELECT id, platform, cohort_key, multiplier, ci_pct, digital_unit_share, confidence, method
         FROM ownership_multipliers
        WHERE platform = ? AND cohort_key = 'default'
          AND effective_from <= ?
        ORDER BY effective_from DESC
        LIMIT 1`
    // Compare against nowIso so hour-granular effective_from timestamps
    // (e.g. '2026-09-11T12:00Z') sort correctly when a same-day recalibration
    // is pushed. Comparing against a date-only asOfDate would incorrectly reject
    // any timestamp with a T component because '2026-09-11T12:00Z' > '2026-09-11'
    // lexically.
    ).get(platform, nowIso) as MultiplierRow | undefined;
    if (row) {
      multipliers.set(platform, row);
      console.log(`[estimate-console-units] ${platform}: multiplier=${row.multiplier} ci=±${(row.ci_pct * 100).toFixed(0)}% digital=${row.digital_unit_share} (${row.confidence}, ${row.method})`);
    } else {
      console.warn(`[estimate-console-units] no active multiplier for ${platform} — rows will be gated as no_multiplier`);
    }
  }

  // ─── 3. Load every eligible (title, platform) from platform_sku_map ───────
  const eligible = db.prepare(
    `SELECT DISTINCT title_id, platform
       FROM platform_sku_map
      WHERE business_model = 'paid'
      ORDER BY platform, title_id`
  ).all() as Array<{ title_id: number; platform: string }>;
  console.log(`[estimate-console-units] eligible (title,platform) pairs: ${eligible.length}`);

  // ─── 4. Pre-load latest store_rating_signal_daily row per (title, platform) ─
  const latestSignal = db.prepare(
    `SELECT title_id, platform, capture_date, rating_count, window_label, raw_json
       FROM store_rating_signal_daily s1
      WHERE capture_date = (
        SELECT MAX(capture_date) FROM store_rating_signal_daily s2
         WHERE s2.title_id = s1.title_id AND s2.platform = s1.platform
      )`
  ).all() as Array<{
    title_id: number; platform: string; capture_date: string;
    rating_count: number | null; window_label: string | null; raw_json: string | null;
  }>;
  const latestSignalByKey = new Map<string, typeof latestSignal[number]>();
  for (const r of latestSignal) latestSignalByKey.set(`${r.title_id}|${r.platform}`, r);

  // ─── 5. Xbox bundled windows: parse raw_json.windows[] once per Xbox title ─
  interface XboxWindows { d7?: number | null; d30?: number | null; ltd?: number | null; }
  const xboxWindowsByTitle = new Map<number, XboxWindows>();
  for (const r of latestSignal) {
    if (r.platform !== "xbox" || !r.raw_json) continue;
    try {
      const parsed = JSON.parse(r.raw_json) as { windows?: Array<{ window: string; rating_count: number | null }> };
      const w: XboxWindows = {};
      for (const win of parsed.windows ?? []) {
        if (win.window === "d7") w.d7 = win.rating_count;
        else if (win.window === "d30") w.d30 = win.rating_count;
        else if (win.window === "ltd") w.ltd = win.rating_count;
      }
      xboxWindowsByTitle.set(r.title_id, w);
    } catch {
      // corrupt raw_json — leave map entry absent, will fall through to ltd from rating_count
    }
  }

  // ─── 6. Steam per-window aggregator from steam_review_history ─────────────
  // Cache appid lookups. platform_sku_map.external_sku is the Steam appid for row_role='base'.
  const steamAppidByTitleId = new Map<number, string>();
  const steamSkus = db.prepare(
    `SELECT title_id, external_sku FROM platform_sku_map
      WHERE platform = 'steam' AND business_model = 'paid'`
  ).all() as Array<{ title_id: number; external_sku: string }>;
  for (const r of steamSkus) steamAppidByTitleId.set(r.title_id, r.external_sku);

  const steamHistoryAgg = db.prepare(
    `SELECT COALESCE(SUM(recommendations_up + recommendations_down), 0) AS s
       FROM steam_review_history
      WHERE app_id = ? AND bucket_start >= ?`
  );

  function steamWindowSignal(titleId: number, days: number): number | null {
    const appid = steamAppidByTitleId.get(titleId);
    if (!appid) return null;
    const cutoff = daysAgoEpochSec(days);
    const r = steamHistoryAgg.get(appid, cutoff) as { s: number };
    // Zero is a valid answer meaning "no reviews in that window" — return 0, not null.
    // The noise gate handles the too-small case.
    return r.s;
  }

  // ─── 7. PS forward-history availability: how many distinct capture_dates do we have? ─
  const psDays = db.prepare(
    `SELECT COUNT(DISTINCT capture_date) AS n FROM store_rating_signal_daily WHERE platform = 'ps5'`
  ).get() as { n: number };
  const psForwardDays = psDays.n;
  console.log(`[estimate-console-units] ps5 forward-history depth: ${psForwardDays} day(s)`);

  // Build (title, platform, prev-capture) map for PS delta math — reused if enough history.
  // For v0: PS d7/d30/d90/m12 all gated as insufficient_history until we have ≥ N+1 days.

  // ─── 8. For each (title, platform, window), compute an EstimateRow ────────
  const rows: EstimateRow[] = [];
  for (const { title_id: titleId, platform } of eligible) {
    const mult = multipliers.get(platform);
    for (const window of ALL_WINDOWS) {
      const row: EstimateRow = {
        titleId, platform, window, asOfDate,
        signalValue: null,
        ownersLow: null, ownersMid: null, ownersHigh: null, unitsMid: null,
        multiplierId: mult?.id ?? null,
        gatedReason: null,
        method: mult ? mult.method : "no_multiplier",
      };

      // ─── Missing multiplier ────────────────────────────────────────────
      if (!mult) {
        row.gatedReason = "no_multiplier";
        rows.push(row);
        continue;
      }

      // ─── Signal lookup per (platform, window) ──────────────────────────
      let signal: number | null = null;

      if (platform === "steam") {
        if (window === "ltd") {
          signal = latestSignalByKey.get(`${titleId}|steam`)?.rating_count ?? null;
        } else {
          const days = WINDOW_DAYS[window]!;
          signal = steamWindowSignal(titleId, days);
        }
      } else if (platform === "xbox") {
        const w = xboxWindowsByTitle.get(titleId);
        if (window === "ltd") {
          signal = w?.ltd ?? latestSignalByKey.get(`${titleId}|xbox`)?.rating_count ?? null;
        } else if (window === "d7") {
          signal = w?.d7 ?? null;
        } else if (window === "d30") {
          signal = w?.d30 ?? null;
        } else {
          // d90, m12 need forward-only history — Xbox native only gives d7/d30.
          row.gatedReason = "insufficient_history";
          rows.push(row);
          continue;
        }
      } else if (platform === "ps5") {
        if (window === "ltd") {
          signal = latestSignalByKey.get(`${titleId}|ps5`)?.rating_count ?? null;
        } else {
          // PS gives only LTD snapshots — every windowed cell needs forward-only
          // day-over-day deltas we don't yet have.
          row.gatedReason = "insufficient_history";
          rows.push(row);
          continue;
        }
      }

      row.signalValue = signal;

      // ─── Missing signal ────────────────────────────────────────────────
      if (signal == null) {
        row.gatedReason = "no_signal";
        rows.push(row);
        continue;
      }

      // ─── Noise gate ────────────────────────────────────────────────────
      if (signal < noiseGate) {
        row.gatedReason = "signal_too_small";
        rows.push(row);
        continue;
      }

      // ─── Apply multiplier ──────────────────────────────────────────────
      const ownersMid = signal * mult.multiplier;
      const ownersLow = ownersMid * (1 - mult.ci_pct);
      const ownersHigh = ownersMid * (1 + mult.ci_pct);
      const unitsMid = ownersMid / mult.digital_unit_share;

      row.ownersMid = Math.round(ownersMid);
      row.ownersLow = Math.round(ownersLow);
      row.ownersHigh = Math.round(ownersHigh);
      row.unitsMid = Math.round(unitsMid);
      rows.push(row);
    }
  }

  // ─── 9. UPSERT into window_estimates_daily ───────────────────────────────
  const upsert = db.prepare(
    `INSERT INTO window_estimates_daily
       (title_id, platform, window, as_of_date,
        signal_value, owners_low, owners_mid, owners_high, units_mid,
        multiplier_id, gated_reason, method, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(title_id, platform, window, as_of_date) DO UPDATE SET
       signal_value  = excluded.signal_value,
       owners_low    = excluded.owners_low,
       owners_mid    = excluded.owners_mid,
       owners_high   = excluded.owners_high,
       units_mid     = excluded.units_mid,
       multiplier_id = excluded.multiplier_id,
       gated_reason  = excluded.gated_reason,
       method        = excluded.method`
  );

  const tx = db.transaction((rs: EstimateRow[]) => {
    for (const r of rs) {
      upsert.run(
        r.titleId, r.platform, r.window, r.asOfDate,
        r.signalValue, r.ownersLow, r.ownersMid, r.ownersHigh, r.unitsMid,
        r.multiplierId, r.gatedReason, r.method, nowIso,
      );
    }
  });
  tx(rows);

  // ─── 10. Summary ─────────────────────────────────────────────────────────
  const byOutcome: Record<string, number> = {};
  for (const r of rows) {
    const key = r.gatedReason ?? "estimated";
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  console.log(`[estimate-console-units] wrote ${rows.length} rows to window_estimates_daily`);
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }

  // Sample the biggest 5 estimated units for a quick sanity check.
  const sample = db.prepare(
    `SELECT w.title_id, w.platform, w.window, w.signal_value, w.units_mid,
            COALESCE(i.name, m.external_sku) AS name
       FROM window_estimates_daily w
  LEFT JOIN console_title_igdb i ON i.title_id = w.title_id
  LEFT JOIN platform_sku_map m
         ON m.title_id = w.title_id AND m.platform = w.platform AND m.sku_role = 'base'
      WHERE w.as_of_date = ? AND w.units_mid IS NOT NULL AND w.window = 'ltd'
      ORDER BY w.units_mid DESC
      LIMIT 8`
  ).all(asOfDate) as Array<{ title_id: number; platform: string; window: string; signal_value: number; units_mid: number; name: string }>;
  console.log(`[estimate-console-units] top-8 LTD units_mid sanity check:`);
  for (const r of sample) {
    console.log(`  ${r.platform.padEnd(5)} ${String(r.signal_value).padStart(9)} sig → ${String(r.units_mid).padStart(11)} units — ${r.name}`);
  }

}

main().catch((err) => {
  console.error("[estimate-console-units] FATAL:", err);
  process.exit(1);
});
