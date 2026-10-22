// Operator deck-contract for Clive Barker's Hellraiser: Revival (2026-10-22).
//
// The Hellraiser daily briefing (the operator's authority) re-anchored PS5 to
// an operator-supplied LTD actual and set explicit ASPs. The buying
// leaderboards must serve the same contract or the two surfaces disagree:
// before this module the PS5 row was entirely Path B-derived (0.7657 × Steam
// revenue, units back-computed at the msrp×aspFactor ASP), which both
// misstated the level and used a different revenue basis than the deck.
//
// The contract, verbatim from the operator (2026-10-22):
//   * PS5 LTD actual: 145,300 units through 2026-10-21 (supersedes the
//     137,000-through-2026-10-18 and 49,200-day-one figures, which remain
//     valid history for their own dates).
//   * ASPs, now and going forward: $40.00/unit Steam, $33.05/console SKU
//     (PS5 and Xbox). These replace the board's msrp×aspFactor basis for
//     this title. Revenue on this basis is modeled, not disclosed actuals.
//   * Daily continuation after the anchor date: Steam daily units × the
//     PS5:Steam unit ratio measured through the anchor (the deck rule).
//   * The anchor is allocated across D1..anchor-date by Steam's daily-unit
//     shape (largest-remainder, sum exact) — the deck's allocation rule.
//
// Durability: this is a serve-time registry, like the aged-title ceilings and
// native-model guards. The nightly estimator cannot erase it; values
// recompute from Steam actuals on every request. The paired
// native_model_guard_v4 row for 11296/ps5 blocks Path B upstream so the
// contract is never fighting a Steam-ratio derivation.

export type DeckContractPlatform = "steam" | "ps5" | "xbox";

export interface HellraiserDeckContractAnchor {
  /** Operator actual: PS5 LTD units through `asOfDate`. */
  units: number;
  /** The anchor's as-of date (latest complete Steam actual day when recorded). */
  asOfDate: string;
  /** Frozen Steam base units through `asOfDate` — the ratio denominator. */
  steamUnitsThroughAnchor: number;
  /** First allocation day (release date; PS5 has no prepurchases). */
  launchWindowStart: string;
  /** Steam base units over the launch window [launchWindowStart, asOfDate] — the allocation denominator. */
  launchWindowSteamUnits: number;
}

export const HELLRAISER_DECK_CONTRACT = {
  familyKey: "clive barker's hellraiser: revival",
  titleIds: { ps5: 11296, xbox: 11355, steam: 10664 },
  /** steam_sales_daily.product_id for the Steam base SKU. */
  steamProductId: 7,
  releaseDate: "2026-10-08",
  anchor: {
    units: 145300,
    asOfDate: "2026-10-21",
    steamUnitsThroughAnchor: 167327,
    launchWindowStart: "2026-10-08",
    launchWindowSteamUnits: 125676,
  } as HellraiserDeckContractAnchor,
  /** Operator ASP directive 2026-10-22: "$40 ASP for Steam and 33.05 for
   *  console SKUs now and going forward" — USD cents per unit. */
  aspUsdCents: { steam: 4000, console: 3305 },
  source:
    "operator deck-contract 2026-10-22: PS5 LTD actual 145,300 units through 2026-10-21; ASPs $40 Steam / $33.05 console (user directive, now and going forward)",
} as const;

/** Appended to the served method string for every row this contract sets. */
export const HELLRAISER_DECK_CONTRACT_TAG = "hellraiser_deck_contract_v1";

const WINDOW_DAYS: Record<string, number | null> = { d7: 7, d30: 30, d90: 90, m12: 365, ltd: null };

export function isHellraiserDeckContractGroup(group: {
  editionGroupKey?: string | null;
  familyTitleIds?: number[] | null;
}): boolean {
  if (group.editionGroupKey === HELLRAISER_DECK_CONTRACT.familyKey) return true;
  const ids = group.familyTitleIds ?? [];
  return ids.includes(HELLRAISER_DECK_CONTRACT.titleIds.ps5)
    || ids.includes(HELLRAISER_DECK_CONTRACT.titleIds.xbox)
    || ids.includes(HELLRAISER_DECK_CONTRACT.titleIds.steam);
}

/**
 * The PS5 daily unit series implied by the contract.
 *
 * Allocation days [launchWindowStart, asOfDate]: the anchor spread across the
 * Steam daily-unit shape with largest-remainder rounding so the window sums
 * to exactly `anchor.units`. Continuation days (> asOfDate): Steam daily
 * units × ratio, where ratio = anchor.units / anchor.steamUnitsThroughAnchor.
 *
 * `steamDaily` must cover the whole launch window (the allocation denominator
 * is fixed, not recomputed from whatever slice is passed in).
 */
export function hellraiserPs5DailySeries(
  steamDaily: ReadonlyArray<{ date: string; units: number }>
): Map<string, number> {
  const a = HELLRAISER_DECK_CONTRACT.anchor;
  const byDate = new Map(steamDaily.map(r => [r.date, r.units]));
  const out = new Map<string, number>();

  // Allocation: largest-remainder over the launch window days present in the
  // Steam actuals. Days the Steam series is missing contribute nothing (and
  // their remainder is redistributed across the days that are present).
  const launchDays: string[] = [];
  for (let d = a.launchWindowStart; d <= a.asOfDate; ) {
    if (byDate.has(d)) launchDays.push(d);
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  const shapeTotal = launchDays.reduce((s, d) => s + (byDate.get(d) ?? 0), 0);
  if (launchDays.length > 0 && shapeTotal > 0) {
    const raw = launchDays.map(d => (a.units * (byDate.get(d) ?? 0)) / shapeTotal);
    const floors = raw.map(Math.floor);
    let remainder = a.units - floors.reduce((s, v) => s + v, 0);
    // Largest remainders get the leftover units, ties broken by date order.
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((x, y) => y.frac - x.frac || x.i - y.i);
    for (const { i } of order) {
      if (remainder <= 0) break;
      floors[i] += 1;
      remainder -= 1;
    }
    launchDays.forEach((d, i) => out.set(d, floors[i]));
  }

  // Continuation after the anchor date.
  const ratio = a.units / a.steamUnitsThroughAnchor;
  byDate.forEach((u, d) => {
    if (d > a.asOfDate) out.set(d, Math.round(u * ratio));
  });
  return out;
}

/**
 * PS5 units for a board window ending at `asOf`: the contract series summed
 * over the window's days (PS5 sells nothing before its release date).
 * Returns null when the window predates the release entirely.
 */
export function hellraiserPs5WindowUnits(
  window: string,
  asOf: string,
  steamDaily: ReadonlyArray<{ date: string; units: number }>
): number | null {
  const days = WINDOW_DAYS[window];
  if (days === undefined) return null;
  const series = hellraiserPs5DailySeries(steamDaily);
  const release = HELLRAISER_DECK_CONTRACT.releaseDate;
  // The window is [end, asOf]; ltd has no lower bound (PS5 sells nothing
  // before its release date, enforced below).
  const end = days == null ? "" : addDays(asOf, -(days - 1));
  let total = 0;
  series.forEach((u, d) => {
    if (d >= release && d <= asOf && d >= end) total += u;
  });
  return total;
}

function addDays(iso: string, n: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Apply the contract to the served board groups of one platform response.
 * PS5: units come from the contract series; revenue = units × $33.05.
 * Xbox: units unchanged (Path B level); revenue = units × $33.05.
 * Steam: units unchanged (actuals); revenue = units × $40.
 *
 * Mutates the group objects in place (same pattern as the other serve-time
 * registries). `window` is the requested board window; `asOf` is the latest
 * Steam actual date in `steamDaily` (the same cutoff the Steam row serves).
 */
export function applyHellraiserDeckContract(
  groups: Array<Record<string, unknown>>,
  platform: string,
  window: string,
  steamDaily: ReadonlyArray<{ date: string; units: number }>
): number {
  if (!groups.some(g => isHellraiserDeckContractGroup(g as never))) return 0;
  const asOf = steamDaily.reduce((m, r) => (r.date > m ? r.date : m), "");
  if (!asOf) return 0;
  const asp =
    platform === "steam" ? HELLRAISER_DECK_CONTRACT.aspUsdCents.steam
    : platform === "ps5" || platform === "xbox" ? HELLRAISER_DECK_CONTRACT.aspUsdCents.console
    : null;
  let touched = 0;
  for (const g of groups) {
    if (!isHellraiserDeckContractGroup(g as never)) continue;
    if (platform === "ps5") {
      const units = hellraiserPs5WindowUnits(window, asOf, steamDaily);
      if (units == null || !(units > 0)) continue;
      const prevUnits = typeof g.unitsMid === "number" ? g.unitsMid : null;
      g.unitsMidEstimated = prevUnits ?? units;
      const scale = prevUnits && prevUnits > 0 ? units / prevUnits : 1;
      g.unitsMid = units;
      if (typeof g.ownersMid === "number" && g.ownersMid > 0) {
        g.ownersMid = Math.max(1, Math.round(g.ownersMid * scale));
      }
      g.aspUsdCents = asp;
      g.revenueMidUsd = Math.round((units * (asp ?? 0)) / 100);
      g.dataSource = "operator_anchor_contract";
      g.revenueCaveat = HELLRAISER_DECK_CONTRACT.source;
      g.method = `${g.method ?? ""}+${HELLRAISER_DECK_CONTRACT_TAG}`.replace(/^\+/, "");
      if (typeof g.estimateMethod === "string") {
        g.estimateMethod = `${g.estimateMethod}+${HELLRAISER_DECK_CONTRACT_TAG}`;
      } else {
        g.estimateMethod = HELLRAISER_DECK_CONTRACT_TAG;
      }
      touched++;
    } else if (platform === "xbox" || platform === "steam") {
      const units = typeof g.unitsMid === "number" && g.unitsMid > 0 ? g.unitsMid : null;
      if (units == null || asp == null) continue;
      g.revenueMidUsdEstimated = typeof g.revenueMidUsd === "number" ? g.revenueMidUsd : null;
      g.aspUsdCents = asp;
      g.revenueMidUsd = Math.round((units * asp) / 100);
      g.dataSource = "operator_asp_contract";
      g.revenueCaveat = `ASP basis per operator directive 2026-10-22 ($${(asp / 100).toFixed(2)}/unit, now and going forward); ${platform === "steam" ? "revenue restated from actuals to the operator ASP basis" : "modeled revenue, not disclosed actuals"}.`;
      g.method = `${g.method ?? ""}+${HELLRAISER_DECK_CONTRACT_TAG}`.replace(/^\+/, "");
      if (typeof g.estimateMethod === "string") {
        g.estimateMethod = `${g.estimateMethod}+${HELLRAISER_DECK_CONTRACT_TAG}`;
      } else {
        g.estimateMethod = HELLRAISER_DECK_CONTRACT_TAG;
      }
      touched++;
    }
  }
  return touched;
}
