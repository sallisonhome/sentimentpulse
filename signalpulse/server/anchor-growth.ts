import type Database from "better-sqlite3";

/**
 * A verified lifetime (LTD) anchor is a known starting point at its as-of date, not a fixed lifetime figure forever.
 * After that date lifetime grows by the estimator's own lifetime growth, scaled by the anchor's calibration:
 *
 *   k       = anchor / estimatorLifetime(asOf)          (listings valued at the anchor date only)
 *   growth  = k x (estimatorLifetime(latest) - estimatorLifetime(asOf))
 *   lifetime = anchor + growth
 *
 * Because every daily value after the anchor date is scaled by the same k, the days after the anchor add up to the
 * growth exactly. Read-side only; stored anchors and estimates never change. Fails closed (returns null, anchor
 * unchanged) when the estimator history is missing, the anchor has no estimator value to calibrate against, or the
 * implied growth is implausible (more than doubling the anchor).
 */
export type AnchorGrowth = {
  revenueUsd: number; units: number | null;
  baseUsd: number; growthUsd: number; k: number;
  estimatorAtAnchorUsd: number; estimatorNowUsd: number; anchorAsOfDate: string; estimatorAsOfDate: string;
};
export const ANCHOR_GROWTH_MAX_RATIO = 1; // growth may not exceed the anchor itself

export function growVerifiedLtdAnchor(
  db: Database.Database, platform: string, titleIds: number[], anchorAsOfDate: string,
  anchorRevenueUsd: number, anchorUnits: number | null, aspFactor: number,
): AnchorGrowth | null {
  if (!(anchorRevenueUsd > 0) || !/^\d{4}-\d{2}-\d{2}/.test(anchorAsOfDate)) return null;
  const asOf = anchorAsOfDate.slice(0, 10);
  let atAnchor = 0, now = 0, nowDate = "";
  for (const id of Array.from(new Set(titleIds))) {
    const msrp = (db.prepare("SELECT MIN(msrp_usd_cents) AS m FROM platform_sku_map WHERE title_id=? AND msrp_usd_cents IS NOT NULL").get(id) as { m: number | null } | undefined)?.m;
    if (!(msrp != null && msrp > 0)) continue;
    const rows = db.prepare(`SELECT as_of_date AS d, units_mid AS u FROM window_estimates_daily
      WHERE title_id=? AND platform=? AND window='ltd' AND units_mid IS NOT NULL ORDER BY as_of_date`).all(id, platform) as Array<{ d: string; u: number }>;
    if (!rows.length) continue;
    // The listing must be valued at the anchor date (a later joiner would add its whole lifetime as growth).
    let base = null as { d: string; u: number } | null;
    for (const r of rows) if (r.d <= asOf) base = r;
    if (!base) { const first = rows.find(r => r.d >= asOf); if (first && (Date.parse(first.d) - Date.parse(asOf)) / 86400000 <= 3) base = first; }
    if (!base) continue;
    const last = rows[rows.length - 1];
    atAnchor += base.u * msrp / 100 * aspFactor;
    now += Math.max(last.u, base.u) * msrp / 100 * aspFactor;
    if (last.d > nowDate) nowDate = last.d;
  }
  if (!(atAnchor > 0) || !(now > atAnchor)) return null;
  const k = anchorRevenueUsd / atAnchor;
  const growth = k * (now - atAnchor);
  if (!Number.isFinite(growth) || !(growth > 0) || growth > anchorRevenueUsd * ANCHOR_GROWTH_MAX_RATIO) return null;
  const revenueUsd = anchorRevenueUsd + growth;
  return {
    revenueUsd, units: anchorUnits != null && anchorUnits > 0 ? Math.round(anchorUnits * revenueUsd / anchorRevenueUsd) : anchorUnits,
    baseUsd: anchorRevenueUsd, growthUsd: growth, k, estimatorAtAnchorUsd: atAnchor, estimatorNowUsd: now,
    anchorAsOfDate: asOf, estimatorAsOfDate: nowDate,
  };
}

/** Estimator lifetime revenue at the anchor date for listings valued then (no growth guard); null when unavailable. */
export function estimatorAtAnchor(db: Database.Database, platform: string, titleIds: number[], anchorAsOfDate: string, aspFactor: number): number | null {
  const asOf = anchorAsOfDate.slice(0, 10);
  let total = 0;
  for (const id of Array.from(new Set(titleIds))) {
    const msrp = (db.prepare("SELECT MIN(msrp_usd_cents) AS m FROM platform_sku_map WHERE title_id=? AND msrp_usd_cents IS NOT NULL").get(id) as { m: number | null } | undefined)?.m;
    if (!(msrp != null && msrp > 0)) continue;
    const rows = db.prepare(`SELECT as_of_date AS d, units_mid AS u FROM window_estimates_daily
      WHERE title_id=? AND platform=? AND window='ltd' AND units_mid IS NOT NULL ORDER BY as_of_date`).all(id, platform) as Array<{ d: string; u: number }>;
    let base = null as { d: string; u: number } | null;
    for (const r of rows) if (r.d <= asOf) base = r;
    if (!base) base = rows.find(r => r.d >= asOf && (Date.parse(r.d) - Date.parse(asOf)) / 86400000 <= 3) ?? null;
    if (base) total += base.u * msrp / 100 * aspFactor;
  }
  return total > 0 ? total : null;
}
