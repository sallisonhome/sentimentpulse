/** Read-side reconciliation only: never feed derived units back into learning. */
export function resolveSalesUnits(revenueUsd: number | null, modeledAspUsdCents: number | null,
  verifiedUnits: number | null = null) {
  if (revenueUsd == null || !Number.isFinite(revenueUsd) || revenueUsd < 0) {
    return { unitsMid: null, aspUsdCents: modeledAspUsdCents, unitSource: "unavailable" };
  }
  // A verified pair provides realized economics, rather than a conflicting MSRP guess.
  if (revenueUsd > 0 && verifiedUnits != null && Number.isFinite(verifiedUnits) && verifiedUnits > 0) {
    return { unitsMid: verifiedUnits, aspUsdCents: revenueUsd * 100 / verifiedUnits, unitSource: "verified_anchor" };
  }
  if (revenueUsd === 0) {
    return { unitsMid: 0, aspUsdCents: modeledAspUsdCents, unitSource: "revenue_derived" };
  }
  if (modeledAspUsdCents == null || !Number.isFinite(modeledAspUsdCents) || modeledAspUsdCents <= 0) {
    return { unitsMid: null, aspUsdCents: null, unitSource: "unavailable" };
  }
  const units = Math.round(revenueUsd * 100 / modeledAspUsdCents);
  return { unitsMid: Number.isSafeInteger(units) ? units : null,
    aspUsdCents: modeledAspUsdCents, unitSource: Number.isSafeInteger(units) ? "revenue_derived" : "unavailable" };
}
