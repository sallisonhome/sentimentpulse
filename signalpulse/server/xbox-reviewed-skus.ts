// Reviewed Xbox SKUs that automatic discovery cannot admit. Microsoft lists some Game Pass
// day-one titles with a $0 price and no Purchase action, so the paid-only discovery gate drops
// them. Each entry is reviewed by hand, takes its price from the same game's PS5 SKUs, and is
// written as a manual override so automatic refresh cannot overwrite it.
export const XBOX_REVIEWED_SOURCE = "xbox_reviewed_ps5_price_match:2026-10-08";
export type ReviewedXboxSku = { bigId: string; role: "base" | "edition"; msrpUsdCents: number; ps5Sku: string };
// attachToTitleId: pin a family whose SKUs are all new to an EXISTING title_id
// instead of allocating a new one. Used when the game already has a console row
// under a non-purchasable listing (e.g. Elden Ring's ratings_only stub) — a
// second title would split the concept across two title_ids and muddy the
// family grouping. Ignored when a family SKU already exists (the DB row's
// title_id is the source of truth and is immutable).
export type ReviewedXboxFamily = { family: string; skus: ReviewedXboxSku[]; attachToTitleId?: number };

export const REVIEWED_XBOX_FAMILIES: ReviewedXboxFamily[] = [{
  family: "Minecraft Dungeons II",
  skus: [
    // PS5 base EP4433-PPSA16064_00-SWPS500000000000 is 2999; PS5 edition ...-0424848725030098 is 4999.
    { bigId: "9P5786PJB9RP", role: "base", msrpUsdCents: 2999, ps5Sku: "EP4433-PPSA16064_00-SWPS500000000000" },
    { bigId: "9NFDXGJ16M47", role: "edition", msrpUsdCents: 4999, ps5Sku: "EP4433-PPSA16064_00-0424848725030098" },
  ],
}, {
  // Released 2026-10-08 (Deluxe id supplied by Steve; the standard id 9NSWRGZBQ2MC was read from the Xbox store, since 9PN93T01JMSR is the Deluxe bundle page). PS5 base EP6853-PPSA25642_00-0082868685413873 is 3999; the PS5
  // Deluxe edition EP6853-PPSA25642_00-DELUXE0000000000 is 4999.
  family: "Clive Barker's Hellraiser: Revival",
  skus: [
    { bigId: "9NSWRGZBQ2MC", role: "base", msrpUsdCents: 3999, ps5Sku: "EP6853-PPSA25642_00-0082868685413873" },
    { bigId: "9N3TVB2GX7CT", role: "edition", msrpUsdCents: 4999, ps5Sku: "EP6853-PPSA25642_00-DELUXE0000000000" },
  ],
}, {
  // Elden Ring's registered Xbox bigId 9NL9DV1SH9LS is a $0 Redeem-only listing
  // (ratings_only stub on title 11066). The purchasable US SKU 9P3J32CTXLRZ
  // ($59.99) never enters via discovery because the game sits outside the
  // top-100 Xbox top-paid chart. Attach it to the existing title 11066 so the
  // concept keeps one Xbox title_id. PS5 base UP0700-PPSA04610_00-ELDENRING0000000 is 5999.
  family: "ELDEN RING",
  attachToTitleId: 11066,
  skus: [
    { bigId: "9P3J32CTXLRZ", role: "base", msrpUsdCents: 5999, ps5Sku: "UP0700-PPSA04610_00-ELDENRING0000000" },
  ],
}, {
  // Released 2026-10-06. Outside the Xbox top-100 top-paid chart, so discovery
  // never sees it (the new-releases channel died 2026-09-11). PS5 base
  // UP8737-PPSA28416_00-SWGALACTICRACER1 is 5999. The Deluxe (9P5X1SGXHTHW) and
  // pre-order-bundle (9NM753GDJ8FS) pages are $0 non-standalone — not registered.
  family: "STAR WARS: Galactic Racer",
  skus: [
    { bigId: "9MXDPXSRVML5", role: "base", msrpUsdCents: 5999, ps5Sku: "UP8737-PPSA28416_00-SWGALACTICRACER1" },
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
