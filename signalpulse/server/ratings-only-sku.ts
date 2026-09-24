// Explicitly verified storefronts may feed rating cards without entering
// the base-SKU sales estimation universe. Never enable arbitrary edition rows.
export const RATINGS_ONLY_SOURCE = "verified_ratings_only:portfolio_2026-09-24";
export const CCU_RATINGS_SOURCE = "verified_ratings_only:ccu_2026-09-24";
export const RATINGS_ONLY_SOURCES = [RATINGS_ONLY_SOURCE, CCU_RATINGS_SOURCE];
export function isVerifiedRatingsOnly(row: {
  sku_role: string; is_manual_override?: number; business_model_source?: string;
}): boolean {
  return row.sku_role === "ratings_only" && row.is_manual_override === 1
    && RATINGS_ONLY_SOURCES.includes(row.business_model_source ?? "");
}
