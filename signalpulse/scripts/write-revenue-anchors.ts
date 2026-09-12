/**
 * write-revenue-anchors.ts
 *
 * Walks every Steam title that has verified sales data
 * (steam_sales_daily.source='portal_fetch') and writes anchor rows into
 * revenue_calibration_anchors for windows d7, d30, d90, m12, ltd.
 *
 * Each anchor row records:
 *  - actual_revenue_usd + actual_units for the window (from steam_sales_daily)
 *  - reference_msrp_usd_cents pulled from platform_sku_map (the current
 *    non-sale MSRP; MUST come from a manual override for titles currently on
 *    sale so we don't lock in a sale price as the reference)
 *  - implied_asp_pct_msrp = (actual_revenue / actual_units) / MSRP
 *  - rolling_asp_median_pct_msrp = median implied ASP over the trailing 90d
 *    calendar days ending at as_of_date
 *  - sale_state = 'active_sale' if implied_asp_pct_msrp < 0.70 *
 *    rolling_asp_median_pct_msrp, else 'baseline'
 *
 * The 0.70 threshold is a first cut based on the observation that Steam
 * front-page discounts routinely go 33-50% off, dragging window-averaged ASPs
 * below trailing median by more than 30%. Tune via app_settings key
 * 'anchor_sale_threshold' (default 0.70) if we get false positives.
 *
 * Idempotent per as_of_date: writes with ON CONFLICT ... DO UPDATE keyed on
 * (title_id, platform, window, as_of_date).
 *
 * NOTE: This script is Steam-only. Non-Steam actuals aren't in the DB.
 * When PSN/MS report data arrives, add new source-branches here.
 */

import { rawSqlite } from "../server/storage";

const DRY_RUN = process.env.DRY_RUN === "1";
const AS_OF = process.env.AS_OF_DATE ?? new Date().toISOString().slice(0, 10);

const WINDOWS: Array<{ key: string; days: number | null }> = [
  { key: "d7",  days: 7 },
  { key: "d30", days: 30 },
  { key: "d90", days: 90 },
  { key: "m12", days: 365 },
  { key: "ltd", days: null },
];

const SALE_THRESHOLD = (() => {
  try {
    const r = rawSqlite
      .prepare(`SELECT value FROM app_settings WHERE key='anchor_sale_threshold'`)
      .get() as { value: string } | undefined;
    if (r?.value) {
      const v = parseFloat(r.value);
      if (Number.isFinite(v) && v > 0 && v < 1) return v;
    }
  } catch { /* table may not exist yet */ }
  return 0.70;
})();

interface Title {
  product_id: number;
  title_id: number;
  external_sku: string;
  msrp_usd_cents: number;
  is_manual_override: number;
  first_date: string;
  last_date: string;
}

function listSteamTitlesWithActuals(): Title[] {
  return rawSqlite.prepare(`
    SELECT
      p.id                                              AS product_id,
      psm.title_id                                      AS title_id,
      psm.external_sku                                  AS external_sku,
      psm.msrp_usd_cents                                AS msrp_usd_cents,
      psm.is_manual_override                            AS is_manual_override,
      (SELECT MIN(date) FROM steam_sales_daily WHERE product_id = p.id) AS first_date,
      (SELECT MAX(date) FROM steam_sales_daily WHERE product_id = p.id) AS last_date
    FROM products p
    JOIN platform_sku_map psm
      ON psm.platform='steam' AND psm.external_sku = CAST(p.steam_app_id AS TEXT)
    WHERE p.id IN (SELECT DISTINCT product_id FROM steam_sales_daily)
      AND psm.business_model = 'paid'
      AND psm.msrp_usd_cents IS NOT NULL
      AND psm.msrp_usd_cents > 0
    ORDER BY p.id
  `).all() as Title[];
}

interface WindowAgg {
  net_units: number;
  net_revenue_usd: number;
  row_count: number;
}

function aggregateWindow(product_id: number, first_date: string, days: number | null, as_of: string): WindowAgg {
  const endDate = as_of;
  const startDate = first_date;
  const cutoff = days == null ? endDate : dateOffset(first_date, days);
  const effectiveEnd = min(endDate, cutoff);
  const r = rawSqlite.prepare(`
    SELECT
      COALESCE(SUM(net_units), 0)        AS net_units,
      COALESCE(SUM(net_revenue_usd), 0)  AS net_revenue_usd,
      COUNT(*)                           AS row_count
    FROM steam_sales_daily
    WHERE product_id = ?
      AND date >= ? AND date <= ?
      AND source = 'portal_fetch'
  `).get(product_id, startDate, effectiveEnd) as WindowAgg;
  return r;
}

function rollingAspMedianPctMsrp(product_id: number, msrp_cents: number, as_of: string): number | null {
  // Compute daily implied_asp / MSRP for the trailing 90 calendar days ending
  // at as_of, filtering days with 0 units. Return median. Null if <7 usable days.
  const start = dateOffset(as_of, -90);
  const rows = rawSqlite.prepare(`
    SELECT net_units, net_revenue_usd
    FROM steam_sales_daily
    WHERE product_id = ?
      AND date >= ? AND date <= ?
      AND source = 'portal_fetch'
      AND net_units > 0
  `).all(product_id, start, as_of) as Array<{net_units:number; net_revenue_usd:number}>;
  if (rows.length < 7) return null;
  const msrp_dollars = msrp_cents / 100;
  const ratios = rows
    .map(r => (r.net_revenue_usd / r.net_units) / msrp_dollars)
    .filter(x => Number.isFinite(x) && x > 0 && x < 5) // sanity clip
    .sort((a, b) => a - b);
  if (ratios.length < 7) return null;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

function dateOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function min(a: string, b: string): string { return a < b ? a : b; }

function main() {
  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  write-revenue-anchors.ts   AS_OF=${AS_OF}  DRY_RUN=${DRY_RUN ? 1 : "unset"}`);
  console.log(`  sale_threshold=${SALE_THRESHOLD.toFixed(2)}`);
  console.log(`══════════════════════════════════════════════════════════`);

  const titles = listSteamTitlesWithActuals();
  console.log(`\nSteam titles with actuals: ${titles.length}`);

  const upsert = rawSqlite.prepare(`
    INSERT INTO revenue_calibration_anchors (
      title_id, platform, window, as_of_date,
      actual_revenue_usd, actual_units, reference_msrp_usd_cents,
      sale_state, implied_asp_pct_msrp, rolling_asp_median_pct_msrp,
      data_source, notes, created_at
    ) VALUES (?, 'steam', ?, ?, ?, ?, ?, ?, ?, ?, 'steam_sales_daily', ?, ?)
    ON CONFLICT (title_id, platform, window, as_of_date) DO UPDATE SET
      actual_revenue_usd         = excluded.actual_revenue_usd,
      actual_units               = excluded.actual_units,
      reference_msrp_usd_cents   = excluded.reference_msrp_usd_cents,
      sale_state                 = excluded.sale_state,
      implied_asp_pct_msrp       = excluded.implied_asp_pct_msrp,
      rolling_asp_median_pct_msrp = excluded.rolling_asp_median_pct_msrp,
      notes                      = excluded.notes
  `);

  let anchors = 0, activeSale = 0, baseline = 0, skippedNoRollingMedian = 0;
  const nowIso = new Date().toISOString();

  const tx = rawSqlite.transaction(() => {
    for (const t of titles) {
      const rollingMedian = rollingAspMedianPctMsrp(t.product_id, t.msrp_usd_cents, AS_OF);
      for (const w of WINDOWS) {
        const agg = aggregateWindow(t.product_id, t.first_date, w.days, AS_OF);
        if (agg.row_count === 0 || agg.net_units === 0) continue;
        const impliedAspPct = (agg.net_revenue_usd / agg.net_units) / (t.msrp_usd_cents / 100);
        let sale_state: "active_sale" | "baseline";
        if (rollingMedian == null) {
          // No rolling median → default to baseline; note it so the refit can
          // choose to exclude these if desired. Only conservative when the
          // title has too few days to establish a normal price band.
          sale_state = "baseline";
          if (w.key === WINDOWS[0].key) skippedNoRollingMedian++;
        } else if (impliedAspPct < SALE_THRESHOLD * rollingMedian) {
          sale_state = "active_sale";
        } else {
          sale_state = "baseline";
        }
        if (sale_state === "active_sale") activeSale++; else baseline++;
        const notes = rollingMedian == null
          ? `manual_msrp_override=${t.is_manual_override}; rolling_median=null (thin history)`
          : `manual_msrp_override=${t.is_manual_override}`;
        if (!DRY_RUN) {
          upsert.run(
            t.title_id, w.key, AS_OF,
            agg.net_revenue_usd, agg.net_units, t.msrp_usd_cents,
            sale_state, impliedAspPct, rollingMedian,
            notes, nowIso,
          );
        }
        anchors++;
      }
    }
  });
  tx();

  console.log(`\nSummary:`);
  console.log(`  anchors written : ${anchors}`);
  console.log(`  baseline        : ${baseline}`);
  console.log(`  active_sale     : ${activeSale}`);
  console.log(`  titles w/o rolling median (<7 usable days) : ${skippedNoRollingMedian}`);
  if (DRY_RUN) console.log(`  (DRY_RUN) no rows written`);

  // Show all anchor rows for this run so operators can eyeball.
  if (!DRY_RUN) {
    const preview = rawSqlite.prepare(`
      SELECT title_id, window, as_of_date, sale_state,
             ROUND(actual_revenue_usd, 0) AS rev, actual_units AS units,
             ROUND(implied_asp_pct_msrp * 100, 1) AS asp_pct,
             ROUND(rolling_asp_median_pct_msrp * 100, 1) AS med_pct
      FROM revenue_calibration_anchors
      WHERE as_of_date = ? AND platform = 'steam'
      ORDER BY title_id, CASE window WHEN 'd7' THEN 1 WHEN 'd30' THEN 2 WHEN 'd90' THEN 3 WHEN 'm12' THEN 4 WHEN 'ltd' THEN 5 END
    `).all(AS_OF);
    console.log(`\nAnchors written this run (${preview.length}):`);
    for (const r of preview as any[]) {
      console.log(`  t=${String(r.title_id).padStart(6)} ${r.window.padEnd(4)} ${r.sale_state.padEnd(11)} rev=$${String(Math.round(r.rev)).padStart(11)} units=${String(r.units).padStart(9)} asp=${r.asp_pct}% med=${r.med_pct ?? "n/a"}%`);
    }
  }
}

main();
