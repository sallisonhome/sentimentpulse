/**
 * write-revenue-anchors.ts     rev 2026-09-12 (title_id rollup + trailing windows)
 *
 * Walks every Steam TITLE that has verified sales data
 * (steam_sales_daily.source='portal_fetch') and writes anchor rows into
 * revenue_calibration_anchors for windows d7, d30, d90, m12, ltd.
 *
 * Aggregation model (2026-09-12 rewrite):
 *
 *   Anchor unit is title_id, NOT product_id. For each title we sum
 *   revenue and units across EVERY products row whose Steam appid is
 *   mapped to that title_id under platform_sku_map with sku_role='base'.
 *   This is what makes "Warhammer 40,000: Space Marine 2 Standard /
 *   Anniversary / 2-Year Anniversary" roll up to one anchor row instead
 *   of three fragmented rows (and one being picked essentially at
 *   random).
 *
 *   DLC is excluded (sku_role != 'base'). The multiplier we calibrate
 *   from these anchors scales base-game units, not DLC attach.
 *
 * Window semantics (2026-09-12 rewrite):
 *
 *   All fixed windows are TRAILING and end at as_of_date:
 *     d7  = (as_of − 7d,  as_of]
 *     d30 = (as_of − 30d, as_of]
 *     d90 = (as_of − 90d, as_of]
 *     m12 = (as_of − 365d, as_of]
 *   ltd is unchanged: everything from the earliest sale date through as_of.
 *
 *   The previous version anchored windows at each product's first sale
 *   date, so d30 = "first 30 days of this SKU's life". For any title
 *   past its launch month the anchor was a fixed historical number.
 *
 * Each anchor row records:
 *  - actual_revenue_usd + actual_units for the window (summed across editions)
 *  - reference_msrp_usd_cents from the base SKU's platform_sku_map row
 *    (the current non-sale MSRP; MUST come from a manual override for
 *    titles currently on sale so we don't lock in a sale price)
 *  - implied_asp_pct_msrp = (actual_revenue / actual_units) / MSRP
 *  - rolling_asp_median_pct_msrp = median implied ASP over the trailing 90
 *    calendar days ending at as_of_date (computed across all base-edition
 *    products, same rollup as the window sums)
 *  - sale_state = 'active_sale' if implied_asp_pct_msrp < 0.70 *
 *    rolling_asp_median_pct_msrp, else 'baseline'
 *
 * The 0.70 threshold is a first cut. Tune via app_settings key
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
const AS_OF = (() => {
  const raw = (process.env.AS_OF_DATE ?? "").trim();
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
})();

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

// A rolled-up title = one title_id + the set of product_ids that make it up.
// product_ids is the list of every products.id whose Steam appid maps to
// this title_id under platform_sku_map with sku_role='base' AND business_model='paid'.
// msrp_usd_cents / is_manual_override come from the base SKU's platform_sku_map
// row. If more than one base row exists per title (rare), we take the
// highest MSRP as the reference so ASP% never exceeds 100% by construction.
interface TitleRollup {
  title_id: number;
  product_ids: number[];
  external_skus: string[];
  msrp_usd_cents: number;
  is_manual_override: number;
  first_date: string;   // earliest date across ALL member products
  last_date: string;    // latest date across ALL member products
}

function listSteamTitlesWithActuals(): TitleRollup[] {
  // Step 1: every products row that (a) has portal_fetch actuals and
  // (b) maps to a paid base SKU. One row per product.
  const rows = rawSqlite.prepare(`
    SELECT
      psm.title_id                                      AS title_id,
      p.id                                              AS product_id,
      psm.external_sku                                  AS external_sku,
      psm.msrp_usd_cents                                AS msrp_usd_cents,
      psm.is_manual_override                            AS is_manual_override,
      (SELECT MIN(date) FROM steam_sales_daily WHERE product_id = p.id AND source='portal_fetch') AS first_date,
      (SELECT MAX(date) FROM steam_sales_daily WHERE product_id = p.id AND source='portal_fetch') AS last_date
    FROM products p
    JOIN platform_sku_map psm
      ON psm.platform='steam' AND psm.external_sku = CAST(p.steam_app_id AS TEXT)
    WHERE p.id IN (SELECT DISTINCT product_id FROM steam_sales_daily WHERE source='portal_fetch')
      AND psm.business_model = 'paid'
      AND psm.sku_role = 'base'
      AND psm.msrp_usd_cents IS NOT NULL
      AND psm.msrp_usd_cents > 0
    ORDER BY psm.title_id, p.id
  `).all() as Array<{
    title_id: number;
    product_id: number;
    external_sku: string;
    msrp_usd_cents: number;
    is_manual_override: number;
    first_date: string | null;
    last_date: string | null;
  }>;

  // Step 2: group by title_id.
  const byTitle = new Map<number, TitleRollup>();
  for (const r of rows) {
    if (r.first_date == null || r.last_date == null) continue;
    const existing = byTitle.get(r.title_id);
    if (!existing) {
      byTitle.set(r.title_id, {
        title_id: r.title_id,
        product_ids: [r.product_id],
        external_skus: [r.external_sku],
        msrp_usd_cents: r.msrp_usd_cents,
        is_manual_override: r.is_manual_override,
        first_date: r.first_date,
        last_date: r.last_date,
      });
    } else {
      existing.product_ids.push(r.product_id);
      existing.external_skus.push(r.external_sku);
      // Prefer the highest MSRP across editions as the reference price.
      // Standard is usually the cheapest edition; using it would inflate
      // implied ASP% for a bundle that sold mostly Deluxe/Ultimate.
      // Highest wins. Manual override is truthy if ANY edition has it
      // (usually the base row).
      if (r.msrp_usd_cents > existing.msrp_usd_cents) {
        existing.msrp_usd_cents = r.msrp_usd_cents;
      }
      if (r.is_manual_override) existing.is_manual_override = 1;
      if (r.first_date < existing.first_date) existing.first_date = r.first_date;
      if (r.last_date > existing.last_date) existing.last_date = r.last_date;
    }
  }
  return Array.from(byTitle.values()).sort((a, b) => a.title_id - b.title_id);
}

interface WindowAgg {
  net_units: number;
  net_revenue_usd: number;
  row_count: number;
}

/**
 * Sum across every product_id in the rollup for a TRAILING window ending
 * at as_of. Trailing means:
 *   ltd → [first_date_across_editions, as_of]
 *   Nd  → [as_of − Nd, as_of]
 * A title that just launched N/2 days ago still gets a valid Nd window;
 * we just sum what's available.
 */
function aggregateWindow(rollup: TitleRollup, days: number | null, as_of: string): WindowAgg {
  const endDate = as_of;
  const startDate = days == null
    ? rollup.first_date
    : dateOffset(as_of, -days + 1); // inclusive lower bound
  if (rollup.product_ids.length === 0) return { net_units: 0, net_revenue_usd: 0, row_count: 0 };
  const placeholders = rollup.product_ids.map(() => "?").join(",");
  const r = rawSqlite.prepare(`
    SELECT
      COALESCE(SUM(net_units), 0)        AS net_units,
      COALESCE(SUM(net_revenue_usd), 0)  AS net_revenue_usd,
      COUNT(*)                           AS row_count
    FROM steam_sales_daily
    WHERE product_id IN (${placeholders})
      AND date >= ? AND date <= ?
      AND source = 'portal_fetch'
  `).get(...rollup.product_ids, startDate, endDate) as WindowAgg;
  return r;
}

/**
 * Trailing-90d median of (daily revenue / daily units) / MSRP across
 * every base-edition product for this title. Days where total units == 0
 * are dropped. Returns null if fewer than 7 usable days exist.
 *
 * Aggregating BY DAY across editions (rather than treating each
 * (product, day) as an independent sample) prevents a low-priced
 * Standard-only day from getting equal weight to a mixed-Deluxe day.
 */
function rollingAspMedianPctMsrp(rollup: TitleRollup, as_of: string): number | null {
  if (rollup.product_ids.length === 0) return null;
  const start = dateOffset(as_of, -90);
  const placeholders = rollup.product_ids.map(() => "?").join(",");
  const rows = rawSqlite.prepare(`
    SELECT date,
           SUM(net_units)        AS net_units,
           SUM(net_revenue_usd)  AS net_revenue_usd
      FROM steam_sales_daily
     WHERE product_id IN (${placeholders})
       AND date >= ? AND date <= ?
       AND source = 'portal_fetch'
     GROUP BY date
    HAVING SUM(net_units) > 0
  `).all(...rollup.product_ids, start, as_of) as Array<{date: string; net_units: number; net_revenue_usd: number}>;
  if (rows.length < 7) return null;
  const msrp_dollars = rollup.msrp_usd_cents / 100;
  const ratios = rows
    .map(r => (r.net_revenue_usd / r.net_units) / msrp_dollars)
    .filter(x => Number.isFinite(x) && x > 0 && x < 5)
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

function main() {
  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  write-revenue-anchors.ts   AS_OF=${AS_OF}  DRY_RUN=${DRY_RUN ? 1 : "unset"}`);
  console.log(`  aggregation=title_id(base editions)  windows=trailing`);
  console.log(`  sale_threshold=${SALE_THRESHOLD.toFixed(2)}`);
  console.log(`══════════════════════════════════════════════════════════`);

  const titles = listSteamTitlesWithActuals();
  console.log(`\nSteam titles with actuals: ${titles.length}`);
  const multiEdition = titles.filter(t => t.product_ids.length > 1);
  console.log(`  of which multi-edition rollups: ${multiEdition.length}`);
  if (multiEdition.length > 0) {
    for (const t of multiEdition.slice(0, 20)) {
      console.log(`    t=${t.title_id} appids=[${t.external_skus.join(",")}] msrp=$${(t.msrp_usd_cents/100).toFixed(2)}`);
    }
  }

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
      const rollingMedian = rollingAspMedianPctMsrp(t, AS_OF);
      for (const w of WINDOWS) {
        const agg = aggregateWindow(t, w.days, AS_OF);
        if (agg.row_count === 0 || agg.net_units === 0) continue;
        const impliedAspPct = (agg.net_revenue_usd / agg.net_units) / (t.msrp_usd_cents / 100);
        let sale_state: "active_sale" | "baseline";
        if (rollingMedian == null) {
          sale_state = "baseline";
          if (w.key === WINDOWS[0].key) skippedNoRollingMedian++;
        } else if (impliedAspPct < SALE_THRESHOLD * rollingMedian) {
          sale_state = "active_sale";
        } else {
          sale_state = "baseline";
        }
        if (sale_state === "active_sale") activeSale++; else baseline++;
        const notes =
          `manual_msrp_override=${t.is_manual_override}` +
          `; editions=${t.product_ids.length}` +
          `; appids=${t.external_skus.join(",")}` +
          (rollingMedian == null ? `; rolling_median=null (thin history)` : ``);
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
