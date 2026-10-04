// Title-level storefront chart rank, shared by every console platform (Xbox, PS5, and any future one).
//
// A storefront chart ranks SKUs/products, not games. Several SKUs of one game (Standard / Deluxe /
// Premium pre-order) can chart separately, and during a pre-purchase window the premium SKU often
// outsells the base. The snapshot table is keyed by (platform, sort_key, date, title_id), so writing one
// row per SKU with INSERT OR REPLACE kept whichever SKU came LAST, i.e. the WORST rank for the title.
// PS5 also numbered ranks by position in a flattened base+edition list, which shifted every later title
// down by the number of editions above it.
//
// Fix: take each chart slot's own storefront position (the number a shopper sees), convert it to a demand
// score (rank^-exponent, the same power-law taper the rank-anchor floor uses), sum the scores of all slots
// that resolve to one title_id, and convert the total back to the equivalent single-slot position:
// rank = max(1, score^(-1/exponent)). A title with one slot keeps its exact store position; a title with
// several slots ranks at least as high as its best slot. Ranks are positions, so ties and gaps are normal.

export const CHART_DEMAND_EXPONENT = 0.7;

export interface ChartSlot { titleId: number; storefrontRank: number }
export interface TitleRank { titleId: number; rank: number; slots: number; bestSlotRank: number }

export const equivalentRank = (score: number, exponent = CHART_DEMAND_EXPONENT) => Math.max(1, Math.round(Math.pow(score, -1 / exponent)));

export function combineChartSlots(slots: ChartSlot[], exponent = CHART_DEMAND_EXPONENT): TitleRank[] {
  const byTitle = new Map<number, { score: number; slots: number; best: number }>();
  for (const s of slots) {
    if (!Number.isFinite(s.storefrontRank) || s.storefrontRank < 1) continue;
    const cur = byTitle.get(s.titleId) ?? { score: 0, slots: 0, best: Infinity };
    cur.score += Math.pow(s.storefrontRank, -exponent);
    cur.slots += 1;
    cur.best = Math.min(cur.best, s.storefrontRank);
    byTitle.set(s.titleId, cur);
  }
  return Array.from(byTitle.entries())
    .sort((a, b) => b[1].score - a[1].score || a[1].best - b[1].best || a[0] - b[0])
    .map(([titleId, v]) => ({ titleId, rank: equivalentRank(v.score, exponent), slots: v.slots, bestSlotRank: v.best }));
}
