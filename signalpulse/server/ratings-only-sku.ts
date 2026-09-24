// Explicitly verified paid storefronts may feed rating cards without entering
// the base-SKU sales estimation universe. Never enable arbitrary edition rows.
export const RATINGS_ONLY_SOURCE = "verified_ratings_only:portfolio_2026-09-24";
export function isVerifiedRatingsOnly(row: {
  sku_role: string; is_manual_override?: number; business_model_source?: string;
}): boolean {
  return row.sku_role === "ratings_only" && row.is_manual_override === 1
    && row.business_model_source === RATINGS_ONLY_SOURCE;
}
