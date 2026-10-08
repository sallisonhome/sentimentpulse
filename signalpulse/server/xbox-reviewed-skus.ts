// Reviewed Xbox SKUs that automatic discovery cannot admit. Microsoft lists some Game Pass
// day-one titles with a $0 price and no Purchase action, so the paid-only discovery gate drops
// them. Each entry is reviewed by hand, takes its price from the same game's PS5 SKUs, and is
// written as a manual override so automatic refresh cannot overwrite it.
export const XBOX_REVIEWED_SOURCE = "xbox_reviewed_ps5_price_match:2026-10-03";
export type ReviewedXboxSku = { bigId: string; role: "base" | "edition"; msrpUsdCents: number; ps5Sku: string };
export type ReviewedXboxFamily = { family: string; skus: ReviewedXboxSku[] };

export const REVIEWED_XBOX_FAMILIES: ReviewedXboxFamily[] = [{
  family: "Minecraft Dungeons II",
  skus: [
    // PS5 base EP4433-PPSA16064_00-SWPS500000000000 is 2999; PS5 edition ...-0424848725030098 is 4999.
    { bigId: "9P5786PJB9RP", role: "base", msrpUsdCents: 2999, ps5Sku: "EP4433-PPSA16064_00-SWPS500000000000" },
    { bigId: "9NFDXGJ16M47", role: "edition", msrpUsdCents: 4999, ps5Sku: "EP4433-PPSA16064_00-0424848725030098" },
  ],
}, {
  // Released 2026-10-08 (store ids supplied by Steve). PS5 base EP6853-PPSA25642_00-0082868685413873 is 3999; the PS5
  // Deluxe edition EP6853-PPSA25642_00-DELUXE0000000000 is 4999.
  family: "Clive Barker's Hellraiser: Revival",
  skus: [
    { bigId: "9PN93T01JMSR", role: "base", msrpUsdCents: 3999, ps5Sku: "EP6853-PPSA25642_00-0082868685413873" },
    { bigId: "9N3TVB2GX7CT", role: "edition", msrpUsdCents: 4999, ps5Sku: "EP6853-PPSA25642_00-DELUXE0000000000" },
  ],
}];

const norm = (s: string) => s.toLowerCase().replace(/[™®]/g, "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
/** The store title must be the family name, optionally followed by an edition label. */
export function storeNameMatchesFamily(storeName: string | null | undefined, family: string): boolean {
  if (!storeName) return false;
  const n = norm(storeName), f = norm(family);
  return n === f || n.startsWith(`${f} `);
}
export type SkuPlan = { bigId: string; role: string; msrpUsdCents: number; action: "insert" | "exists" | "reject"; reason?: string };
/** Pure plan: every SKU needs a matching store name, base before edition, one base per family. */
export function planReviewedFamily(
  fam: ReviewedXboxFamily, storeNames: Record<string, string | null>, existing: Set<string>,
): SkuPlan[] {
  const bases = fam.skus.filter(s => s.role === "base");
  if (bases.length !== 1) return fam.skus.map(s => ({ bigId: s.bigId, role: s.role, msrpUsdCents: s.msrpUsdCents, action: "reject", reason: "need_exactly_one_base" }));
  return fam.skus.map(s => {
    const out = { bigId: s.bigId, role: s.role, msrpUsdCents: s.msrpUsdCents };
    if (!(s.msrpUsdCents > 0)) return { ...out, action: "reject" as const, reason: "no_price" };
    if (!storeNameMatchesFamily(storeNames[s.bigId], fam.family)) return { ...out, action: "reject" as const, reason: "store_name_mismatch" };
    return { ...out, action: existing.has(s.bigId) ? "exists" as const : "insert" as const };
  });
}
