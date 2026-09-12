/**
 * refit-ownership-multipliers.ts
 *
 * Reads revenue_calibration_anchors for baseline-state Steam rows at m12 + ltd
 * windows, joins to the current estimator's units_mid from
 * window_estimates_daily, and computes an observed ratio:
 *
 *   ratio_i = actual_revenue_i / (units_mid_i × reference_MSRP × aspFactor)
 *
 * where aspFactor is the current app_settings value (or ASP_FACTOR_DEFAULTS
 * from server/routes-console-leaderboards.ts if unset). The new multiplier is
 * old_multiplier × weighted_median(ratio_i).
 *
 * Weighting: window m12 gets weight 365, window ltd gets weight = days since
 * first_sale for that title. Equal-weighted for anchors within the same
 * (title, window) — but there's at most one row per (title, window, as_of)
 * so each anchor contributes exactly one weighted ratio.
 *
 * SAFETY:
 *  - DRY_RUN=1 (default in workflow) prints the proposed change; no DB writes.
 *  - Even without DRY_RUN, applies a per-refit cap of 3× step change relative
 *    to current multiplier (so a bad anchor batch can't 10× overnight).
 *  - Refit only fires if n_anchors ≥ MIN_ANCHORS (default 2; env override
 *    MIN_ANCHORS).
 *  - Every refit inserts a calibration_events row (whether applied or not)
 *    so we retain a full audit trail.
 *  - Only 'steam' platform for now (no PSN/MS actuals in DB yet).
 */

import { rawSqlite } from "../server/storage";

const DRY_RUN = process.env.DRY_RUN === "1";
const AS_OF = process.env.AS_OF_DATE ?? new Date().toISOString().slice(0, 10);
const MIN_ANCHORS = parseInt(process.env.MIN_ANCHORS ?? "2", 10);
const MAX_STEP = parseFloat(process.env.MAX_STEP ?? "3.0"); // cap: |new/old| ≤ MAX_STEP
const COHORT = "default"; // single-cohort world today

const ASP_DEFAULTS = { steam: 0.66, ps5: 0.80, xbox: 0.80 };

function aspFactorFor(platform: "steam"|"ps5"|"xbox"): number {
  try {
    const r = rawSqlite.prepare(`SELECT value FROM app_settings WHERE key=?`).get(`asp_factor_${platform}`) as {value:string}|undefined;
    if (r?.value) {
      const v = parseFloat(r.value);
      if (Number.isFinite(v) && v > 0 && v <= 1) return v;
    }
  } catch { /* no table */ }
  return ASP_DEFAULTS[platform];
}

interface AnchorRow {
  title_id: number;
  window: string;
  actual_revenue_usd: number;
  reference_msrp_usd_cents: number;
  units_mid: number;
  first_date: string;
}

function loadAnchors(platform: string, asOf: string): AnchorRow[] {
  return rawSqlite.prepare(`
    WITH latest_est AS (
      SELECT title_id, window, units_mid
        FROM window_estimates_daily
       WHERE platform = ?
         AND units_mid IS NOT NULL
         AND (title_id, window, as_of_date) IN (
             SELECT title_id, window, MAX(as_of_date)
               FROM window_estimates_daily
              WHERE platform = ? AND units_mid IS NOT NULL
              GROUP BY title_id, window
         )
    ),
    first_sale AS (
      SELECT psm.title_id,
             (SELECT MIN(date) FROM steam_sales_daily
               WHERE product_id = (SELECT id FROM products WHERE CAST(steam_app_id AS TEXT) = psm.external_sku)
             ) AS first_date
        FROM platform_sku_map psm
       WHERE psm.platform = ?
    )
    SELECT
      a.title_id, a.window, a.actual_revenue_usd, a.reference_msrp_usd_cents,
      e.units_mid, fs.first_date
    FROM revenue_calibration_anchors a
    JOIN latest_est e USING (title_id, window)
    LEFT JOIN first_sale fs USING (title_id)
    WHERE a.platform = ?
      AND a.as_of_date = ?
      AND a.window IN ('m12', 'ltd')
      AND a.sale_state = 'baseline'
      AND e.units_mid > 0
    ORDER BY a.title_id, a.window
  `).all(platform, platform, platform, platform, asOf) as AnchorRow[];
}

function weightedMedian(items: Array<{value:number; weight:number}>): number {
  const sorted = items.slice().sort((a, b) => a.value - b.value);
  const totalW = sorted.reduce((s, x) => s + x.weight, 0);
  let cum = 0;
  for (const it of sorted) {
    cum += it.weight;
    if (cum >= totalW / 2) return it.value;
  }
  return sorted[sorted.length - 1].value;
}

function main() {
  const platform = "steam";
  const aspFactor = aspFactorFor(platform);

  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  refit-ownership-multipliers.ts   AS_OF=${AS_OF}  DRY_RUN=${DRY_RUN ? 1 : "unset"}`);
  console.log(`  platform=${platform}  cohort=${COHORT}  aspFactor=${aspFactor}`);
  console.log(`  min_anchors=${MIN_ANCHORS}  max_step=${MAX_STEP}×`);
  console.log(`══════════════════════════════════════════════════════════`);

  const cur = rawSqlite.prepare(`
    SELECT id, multiplier, ci_pct, digital_unit_share, confidence, method, effective_from
      FROM ownership_multipliers
     WHERE platform = ? AND cohort_key = ?
     ORDER BY effective_from DESC
     LIMIT 1
  `).get(platform, COHORT) as any;
  if (!cur) {
    console.log(`\nERR: no existing multiplier row for (${platform}, ${COHORT}) — seed first`);
    process.exit(1);
  }
  console.log(`\nCurrent multiplier row:`, JSON.stringify(cur));

  const anchors = loadAnchors(platform, AS_OF);
  console.log(`\nBaseline anchors joined to estimator (${anchors.length}):`);
  const rows: Array<{title:number; win:string; ratio:number; weight:number; est_rev:number; act:number}> = [];
  for (const a of anchors) {
    const msrp_dollars = a.reference_msrp_usd_cents / 100;
    const est_rev = a.units_mid * msrp_dollars * aspFactor;
    if (est_rev <= 0) {
      console.log(`  t=${a.title_id} ${a.window}: est_rev=0, skipping`);
      continue;
    }
    const ratio = a.actual_revenue_usd / est_rev;
    let weight = 365;
    if (a.window === "ltd") {
      if (a.first_date) {
        const days = Math.max(1, Math.round(
          (new Date(AS_OF + "T00:00:00Z").getTime() - new Date(a.first_date + "T00:00:00Z").getTime())
            / 86400000
        ));
        weight = days;
      } else {
        weight = 730; // 2y placeholder if first_sale missing
      }
    }
    rows.push({ title: a.title_id, win: a.window, ratio, weight, est_rev, act: a.actual_revenue_usd });
    console.log(`  t=${String(a.title_id).padStart(6)} ${a.window.padEnd(4)} act=$${Math.round(a.actual_revenue_usd).toLocaleString().padStart(13)} est=$${Math.round(est_rev).toLocaleString().padStart(13)} ratio=${ratio.toFixed(2)}× weight=${weight}`);
  }

  if (rows.length < MIN_ANCHORS) {
    console.log(`\nSKIP: n=${rows.length} < MIN_ANCHORS=${MIN_ANCHORS}. No refit.`);
    process.exit(0);
  }

  const obsRatio = weightedMedian(rows.map(r => ({ value: r.ratio, weight: r.weight })));
  const proposedNew = cur.multiplier * obsRatio;
  const step = proposedNew / cur.multiplier;
  const cappedNew = Math.abs(Math.log(step)) > Math.log(MAX_STEP)
    ? cur.multiplier * (step > 1 ? MAX_STEP : 1 / MAX_STEP)
    : proposedNew;
  const wasCapped = cappedNew !== proposedNew;

  console.log(`\nWeighted median ratio (act/est): ${obsRatio.toFixed(3)}×`);
  console.log(`Current multiplier             : ${cur.multiplier.toFixed(3)}`);
  console.log(`Proposed new (uncapped)        : ${proposedNew.toFixed(3)}`);
  if (wasCapped) console.log(`⚠ Capped at ${MAX_STEP}× step → ${cappedNew.toFixed(3)}`);
  console.log(`Change                         : ${((cappedNew / cur.multiplier - 1) * 100).toFixed(1)}%`);

  const nowIso = new Date().toISOString();
  const sample = rows.map(r => ({
    title_id: r.title, window: r.win,
    ratio: Number(r.ratio.toFixed(3)),
    weight: r.weight,
  }));
  const eventRow = {
    as_of_date: AS_OF,
    platform,
    cohort_key: COHORT,
    anchor_count: rows.length,
    anchor_sample_json: JSON.stringify(sample),
    window_used: "m12+ltd",
    weight_method: "window_days_length_weighted_median",
    observed_ratio: obsRatio,
    old_multiplier: cur.multiplier,
    new_multiplier: cappedNew,
    method: "calibrated_from_actuals_v1",
    applied: DRY_RUN ? 0 : 1,
    notes: wasCapped ? `capped from ${proposedNew.toFixed(3)} at ${MAX_STEP}× step` : null,
    created_at: nowIso,
  };

  if (DRY_RUN) {
    console.log(`\n(DRY_RUN) would insert calibration_events row:`);
    console.log(JSON.stringify(eventRow, null, 2));
    console.log(`\n(DRY_RUN) would insert ownership_multipliers row with:`);
    console.log(`  platform=${platform} cohort=${COHORT} multiplier=${cappedNew.toFixed(3)} effective_from=${AS_OF} method=calibrated_from_actuals_v1`);
    process.exit(0);
  }

  const tx = rawSqlite.transaction(() => {
    rawSqlite.prepare(`
      INSERT INTO calibration_events (
        as_of_date, platform, cohort_key, anchor_count, anchor_sample_json,
        window_used, weight_method, observed_ratio, old_multiplier, new_multiplier,
        method, applied, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventRow.as_of_date, eventRow.platform, eventRow.cohort_key,
      eventRow.anchor_count, eventRow.anchor_sample_json,
      eventRow.window_used, eventRow.weight_method,
      eventRow.observed_ratio, eventRow.old_multiplier, eventRow.new_multiplier,
      eventRow.method, eventRow.applied, eventRow.notes, eventRow.created_at,
    );

    rawSqlite.prepare(`
      INSERT INTO ownership_multipliers (
        platform, cohort_key, multiplier, ci_pct, digital_unit_share,
        confidence, method, notes, gp_rating_deflator,
        effective_from, created_at
      ) VALUES (?, ?, ?, ?, ?, 'calibrated', 'calibrated_from_actuals_v1', ?, ?, ?, ?)
      ON CONFLICT (platform, cohort_key, effective_from) DO UPDATE SET
        multiplier = excluded.multiplier,
        ci_pct     = excluded.ci_pct,
        confidence = excluded.confidence,
        method     = excluded.method,
        notes      = excluded.notes
    `).run(
      platform, COHORT, cappedNew,
      cur.ci_pct, cur.digital_unit_share,
      `Weighted median of ${rows.length} baseline anchors (m12+ltd). ratio=${obsRatio.toFixed(3)}${wasCapped ? ", capped" : ""}`,
      cur.gp_rating_deflator,
      AS_OF, nowIso,
    );
  });
  tx();

  console.log(`\n✓ Applied: ownership_multipliers row inserted for effective_from=${AS_OF}`);
  console.log(`✓ Audit: calibration_events row inserted`);
}

main();
