// Steam sales unit accounting shared by leaderboards, digests, country charts
// and every ASP calculation.
//
// Steamworks reports a "Steam DLC units" row next to "Steam units". For a
// pre-purchase whose edition grants bonus content, Steamworks also lists the
// bonus package as a DLC unit with no revenue. That row is an entitlement
// attached to a unit of the base game that was already counted, not a second
// sale. Counting it as a unit doubled the unit denominator and halved ASP
// (Hellraiser: 19,303 base units at $809,597 plus 19,303 DLC units at $0).
//
// Rule: a DLC row with no gross or net revenue is a bonus entitlement and
// contributes no sold units. A DLC row with revenue (for example a future paid
// base-to-Deluxe upgrade) is a real sale and is still tracked as DLC, never
// merged into base-game copies.

export interface SalesRowLike {
  skuGroup: string;
  netUnits: number | null;
  netRevenueUsd: number | null;
  grossRevenueUsd?: number | null;
}

export function isBonusEntitlementRow(r: SalesRowLike): boolean {
  return r.skuGroup === "dlc"
    && (r.netRevenueUsd ?? 0) <= 0
    && (r.grossRevenueUsd ?? 0) <= 0;
}
