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
// several slots ranks at least as high as its best slot.
//
// Ties: a store chart has no ties, so equal ranks are broken the way the storefront orders them. A title with one
// slot always keeps its exact store position (the number a shopper sees, free-to-play excluded). Titles with several
// slots are placed at their demand-equivalent position, in order of equivalent rank, then better raw storefront
// position, then title id, each taking the nearest position at or below that is not already held by another title.
// Result: ranks are unique, single-slot titles never move, and a combined title never ranks better than its
// demand-equivalent position.

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
  const entries = Array.from(byTitle.entries());
  const used = new Set<number>(entries.filter(([, v]) => v.slots === 1).map(([, v]) => v.best));
  const out: TitleRank[] = entries.filter(([, v]) => v.slots === 1).map(([titleId, v]) => ({ titleId, rank: v.best, slots: 1, bestSlotRank: v.best }));
  const multi = entries.filter(([, v]) => v.slots > 1)
    .map(([titleId, v]) => ({ titleId, v, eq: equivalentRank(v.score, exponent) }))
    .sort((a, b) => a.eq - b.eq || a.v.best - b.v.best || a.titleId - b.titleId);
  for (const m of multi) {
    let r = m.eq;
    while (used.has(r)) r++;
    used.add(r);
    out.push({ titleId: m.titleId, rank: r, slots: m.v.slots, bestSlotRank: m.v.best });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
