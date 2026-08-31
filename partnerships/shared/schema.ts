import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Enums (exported for both server and client) ─────────────────────────────

export const OPPORTUNITY_STATES = ["In Negotiation", "Secured"] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const OPPORTUNITY_CATEGORIES = ["Revenue", "Marketing"] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

// Top-level bucket → drives the PDP 4 quadrants and dashboard rollups.
export const OPPORTUNITY_BUCKETS = [
  "IncrementalRevenue",
  "PhysicalRetail",
  "MarketingOpportunity",
  "CollectorsEdition",
] as const;
export type OpportunityBucket = (typeof OPPORTUNITY_BUCKETS)[number];

// Incremental Revenue subtypes (spec 1.a–1.k).
export const INCREMENTAL_REVENUE_SUBTYPES = [
  "Gamepass (XBOX)",
  "PS+ (PlayStation)",
  "Cloud — Luna",
  "Cloud — GeForce Now",
  "Cloud — Other",
  "Hardware Bundle — Console",
  "OEM — GPU Pack In",
  "OEM Hardware Bundle — PC Hardware",
  "Digital Preload",
  "Digital Key Sales",
  "Physical Collector's Edition",
] as const;
export type IncrementalRevenueSubtype =
  (typeof INCREMENTAL_REVENUE_SUBTYPES)[number];

export const CONSOLE_BUNDLE_PLATFORMS = ["PlayStation", "XBOX", "Switch 2"] as const;
export const PC_HARDWARE_BRANDS = ["Lenovo", "HP", "Dell", "ASUS", "Other"] as const;
export const DIGITAL_KEY_VENDORS = [
  "Genba",
  "Fanatical",
  "HeyBox (China)",
  "Green Man Gaming",
  "Humble Store",
  "Other",
] as const;

export const MARKETING_PLATFORMS = [
  "PlayStation",
  "XBOX",
  "Nintendo",
  "PC — Steam",
  "PC — EGS",
  "Other",
] as const;

export const MARKETING_SUBTYPES = [
  "PlayStation State of Play",
  "XBOX Games Showcase",
  "Nintendo Direct",
  "Steam Next Fest",
  "Steam Demo Days",
  "Other",
] as const;

export const MARKETING_IMPACT = ["Small", "Medium", "Large"] as const;
export type MarketingImpact = (typeof MARKETING_IMPACT)[number];

// Physical Retail partner enums.
export const RETAIL_PARTNERS = [
  "Solutions 2 Go",
  "NightHawk",
  "U&I Entertainment / Cities",
  "Plaion",
  "Other",
] as const;

export const RETAIL_TERRITORIES = [
  "North America",
  "Europe",
  "Japan",
  "Worldwide",
  "Other",
] as const;

// ─── Opportunities ───────────────────────────────────────────────────────────
//
// One row per opportunity. `bucket` drives which PDP quadrant it lands in and
// which dashboard rollup column it contributes to. `subtype` is the specific
// deal type inside that bucket. Bucket-specific fields (dropdown selections,
// dates, dollar amounts) live in a JSON blob (`extra`) so the schema stays
// stable as we discover new subtypes without a migration for every one.
//
// Soft-delete is via `flagged_removed_at` (per spec: "flag or remove
// opportunities if a discussion ends in no value add partnership"). Deleted
// rows stay in the table for audit.

export const opportunities = sqliteTable(
  "opportunities",
  {
    id: text("id").primaryKey(), // nanoid
    productId: integer("product_id").notNull(), // FK to signalpulse.products.id (read-only)
    bucket: text("bucket").notNull().$type<OpportunityBucket>(),
    subtype: text("subtype").notNull(),
    category: text("category").notNull().$type<OpportunityCategory>(),
    state: text("state").notNull().$type<OpportunityState>(),
    // Revenue category → dollar value of the deal
    revenueUsd: real("revenue_usd"),
    // Marketing category → structured fields (spec: name/platform/date/value)
    marketingName: text("marketing_name"),
    marketingPlatform: text("marketing_platform"),
    marketingStartDate: text("marketing_start_date"), // ISO date
    marketingEndDate: text("marketing_end_date"), // ISO date (optional)
    marketingValueUsd: real("marketing_value_usd"), // in-kind value $
    marketingReach: integer("marketing_reach"), // audience reach / impressions
    marketingImpact: text("marketing_impact").$type<MarketingImpact>(), // Small/Med/Large
    // Free-text detail field
    details: text("details"),
    // Bucket-specific dropdown selections and "Other" text
    extra: text("extra_json"), // JSON blob
    // Soft-flag
    flaggedRemovedAt: text("flagged_removed_at"),
    flaggedReason: text("flagged_reason"),
    // Audit
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    byProduct: uniqueIndex("opportunities_by_product_time").on(
      t.productId,
      t.createdAt,
    ),
  }),
);

export const insertOpportunitySchema = createInsertSchema(opportunities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Opportunity = typeof opportunities.$inferSelect;
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;

// ─── Physical Retail Partners ────────────────────────────────────────────────
//
// One row per partner per title. A title can have many partners (spec: "+ Add
// Partner"). Rolls up into dashboard column 11 (Partner names) and column 12
// (Sum of MG $).

export const physicalRetailPartners = sqliteTable("physical_retail_partners", {
  id: text("id").primaryKey(),
  productId: integer("product_id").notNull(),
  partnerName: text("partner_name").notNull(), // one of RETAIL_PARTNERS
  partnerNameOther: text("partner_name_other"), // populated when partnerName='Other'
  territoriesJson: text("territories_json").notNull(), // JSON string[] from RETAIL_TERRITORIES
  territoryOtherCountriesJson: text("territory_other_countries_json"), // JSON string[] of countries
  mgAmountUsd: real("mg_amount_usd").notNull().default(0),
  royaltyPctNet: real("royalty_pct_net").notNull().default(0),
  state: text("state").notNull().$type<OpportunityState>(),
  details: text("details"),
  flaggedRemovedAt: text("flagged_removed_at"),
  flaggedReason: text("flagged_reason"),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertRetailPartnerSchema = createInsertSchema(physicalRetailPartners).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type PhysicalRetailPartner = typeof physicalRetailPartners.$inferSelect;
export type InsertPhysicalRetailPartner = z.infer<typeof insertRetailPartnerSchema>;

// ─── Collectors Edition Items ────────────────────────────────────────────────
//
// A title can have at most one Physical Collector's Edition record (captured
// on the `opportunities` row with bucket='CollectorsEdition'), but multiple
// items inside it. This table is the "+ Item" widget in the spec.

export const collectorsEditionItems = sqliteTable("collectors_edition_items", {
  id: text("id").primaryKey(),
  productId: integer("product_id").notNull(),
  opportunityId: text("opportunity_id"), // FK to opportunities.id (nullable)
  itemName: text("item_name").notNull(),
  manufacturingCostUsd: real("manufacturing_cost_usd"), // null = TBD
  manufacturingCostTbd: integer("manufacturing_cost_tbd", { mode: "boolean" })
    .notNull()
    .default(false),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
});

export const insertCEItemSchema = createInsertSchema(collectorsEditionItems).omit({
  id: true,
  createdAt: true,
});
export type CollectorsEditionItem = typeof collectorsEditionItems.$inferSelect;
export type InsertCollectorsEditionItem = z.infer<typeof insertCEItemSchema>;

// ─── Audit log (state changes and soft-deletes) ──────────────────────────────

export const opportunityAuditLog = sqliteTable("opportunity_audit_log", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(), // 'opportunity' | 'retail_partner' | 'ce_item'
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(), // 'create' | 'update' | 'state_change' | 'flag_removed' | 'restore'
  fromState: text("from_state"),
  toState: text("to_state"),
  changesJson: text("changes_json"),
  actor: text("actor"),
  createdAt: text("created_at").notNull(),
});

export type OpportunityAuditRow = typeof opportunityAuditLog.$inferSelect;

// ─── API types (shared between server and client) ────────────────────────────

// The read-only projection of a SignalPulse product this app needs.
export type PartnershipsTitle = {
  id: number;
  title: string;
  platforms: string[];
  releaseDate: string; // ISO
  launchMsrpUsd: number | null;
  steamAppId: string | null;
  steamHeaderImageUrl: string | null;
};

// Dashboard row — one per title with at least one non-flagged opportunity.
export type DashboardRow = {
  title: PartnershipsTitle;
  securedRevenueCount: number;
  securedRevenueUsd: number;
  inDiscussionRevenueCount: number;
  inDiscussionRevenueUsd: number;
  marketingSecuredCount: number;
  marketingInDiscussionCount: number;
  largeMarketingCount: number;
  physicalRetailPartners: string[]; // display names
  physicalRetailMgUsd: number;
};

// PDP payload for a single title (drives header, ring chart, 4 quadrants,
// In Discussion summary).
export type PdpPayload = {
  title: PartnershipsTitle;
  totalSecuredRevenueUsd: number;
  // Ring chart: one slice per bucket, secured $ share.
  ringChart: Array<{ bucket: OpportunityBucket; label: string; usd: number }>;
  quadrants: {
    physicalRetail: {
      secured: PhysicalRetailPartner[];
      inDiscussion: PhysicalRetailPartner[];
    };
    incrementalRevenue: {
      secured: Opportunity[];
      inDiscussion: Opportunity[];
    };
    collectorsEditions: {
      secured: Opportunity[];
      inDiscussion: Opportunity[];
      items: CollectorsEditionItem[];
    };
    marketingOpportunities: {
      secured: Opportunity[];
      inDiscussion: Opportunity[];
    };
  };
};
