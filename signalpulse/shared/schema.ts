import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Products ────────────────────────────────────────────────────────────────

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  publisher: text("publisher").notNull().default("Saber Interactive"),
  isSaberPublished: integer("is_saber_published", { mode: "boolean" }).notNull().default(true),
  platforms: text("platforms").notNull(), // JSON array: ["PC (Steam)", "PS5", ...]
  playerFormat: text("player_format").notNull(), // co_op | multiplayer | single_player
  genre: text("genre").notNull(),
  releaseDate: text("release_date").notNull(), // ISO date string
  targetRetailPriceUsd: real("target_retail_price_usd"),
  perPlatformPricing: text("per_platform_pricing"), // JSON: {"PS5": 69.99, "Steam": 59.99}
  steamAppId: text("steam_app_id"),
  forecastMode: text("forecast_mode").notNull().default("manual"), // manual | auto_generate
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// ─── Product Forecasts (Comps-Based) ─────────────────────────────────────────

export const productForecastsComps = sqliteTable("product_forecasts_comps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  platform: text("platform").notNull(),
  forecastUnits: integer("forecast_units").notNull().default(0),
  adjustedPct: real("adjusted_pct").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertForecastCompsSchema = createInsertSchema(productForecastsComps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertForecastComps = z.infer<typeof insertForecastCompsSchema>;
export type ForecastComps = typeof productForecastsComps.$inferSelect;

// ─── Steam Wishlist Daily ────────────────────────────────────────────────────

export const steamWishlistDaily = sqliteTable("steam_wishlist_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  cumulativeCount: integer("cumulative_count").notNull().default(0),
  dailyDelta: integer("daily_delta").notNull().default(0),
  source: text("source").notNull().default("manual"), // api | manual | estimated
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("steam_wishlist_unique").on(table.productId, table.date),
}));

export const insertSteamWishlistSchema = createInsertSchema(steamWishlistDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertSteamWishlist = z.infer<typeof insertSteamWishlistSchema>;
export type SteamWishlistDaily = typeof steamWishlistDaily.$inferSelect;

// ─── Steam Wishlist Reporting Daily (IPartnerFinancialsService) ─────────────
// Raw daily-delta rows from the *correct* Steamworks Partner Financials API
// (GetAppWishlistReporting). Each row is a per-day delta for a given product,
// NOT a cumulative total. Kept separate from the legacy `steam_wishlist_daily`
// table (which stores cumulativeCount/dailyDelta and is still written to by
// ingestion for dashboard backwards-compatibility — see ingestion.ts).
export const steamWishlistReportingDaily = sqliteTable("steam_wishlist_reporting_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD (GMT)
  wishlistAdds: integer("wishlist_adds").notNull().default(0),
  wishlistDeletes: integer("wishlist_deletes").notNull().default(0),
  wishlistPurchases: integer("wishlist_purchases").notNull().default(0),
  wishlistGifts: integer("wishlist_gifts").notNull().default(0),
  wishlistAddsWindows: integer("wishlist_adds_windows").notNull().default(0),
  wishlistAddsMac: integer("wishlist_adds_mac").notNull().default(0),
  wishlistAddsLinux: integer("wishlist_adds_linux").notNull().default(0),
  // Optional dumps for later country/language analysis without needing a re-fetch:
  countrySummaryJson: text("country_summary_json"), // full JSON of country_summary array
  languageSummaryJson: text("language_summary_json"), // full JSON of language_summary array
  fetchedAt: text("fetched_at").notNull(), // ISO timestamp of fetch
  source: text("source").notNull().default("api"), // "api" or "csv-backfill"
}, (table) => ({
  uniqueProductDate: uniqueIndex("steam_wishlist_reporting_unique").on(table.productId, table.date),
}));

export const insertSteamWishlistReportingSchema = createInsertSchema(steamWishlistReportingDaily).omit({
  id: true,
});

export type InsertSteamWishlistReporting = z.infer<typeof insertSteamWishlistReportingSchema>;
export type SteamWishlistReportingDaily = typeof steamWishlistReportingDaily.$inferSelect;

// ─── Steam Prepurchase Daily ─────────────────────────────────────────────────

export const steamPrepurchaseDaily = sqliteTable("steam_prepurchase_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  cumulativeCount: integer("cumulative_count").notNull().default(0),
  dailyDelta: integer("daily_delta").notNull().default(0),
  source: text("source").notNull().default("manual"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("steam_prepurchase_unique").on(table.productId, table.date),
}));

export const insertSteamPrepurchaseSchema = createInsertSchema(steamPrepurchaseDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertSteamPrepurchase = z.infer<typeof insertSteamPrepurchaseSchema>;
export type SteamPrepurchaseDaily = typeof steamPrepurchaseDaily.$inferSelect;

// ─── Steam Sales Daily (Saber CSV + Focus portal ingest) ─────────────────
//
// v3.0 (2026-08-11): unified sales table for BOTH Steamworks CSV uploads
// (Saber-published titles) and Focus portal-page ingest (Focus-published
// titles like Space Marine 2). Stores one row per (productId, date, skuGroup)
// where skuGroup partitions the product's SKUs into logical buckets:
//
//   - 'base'    → main game SKUs (base game + Deluxe/Anniversary editions).
//                 Cumulative across all these SKUs per the rule established
//                 for wishlists ('cumulative across main SKUs, not DLCs').
//   - 'dlc'     → all DLC/season-pass/cosmetic-pack SKUs rolled up.
//   - 'other'   → soundtrack, artbook, retail-key redemptions, misc.
//
// netUnits and netRevenueUsd are the ingest values; source tracks provenance.
export const steamSalesDaily = sqliteTable("steam_sales_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  skuGroup: text("sku_group").notNull(), // 'base' | 'dlc' | 'other'
  netUnits: integer("net_units").notNull().default(0),
  grossUnits: integer("gross_units").notNull().default(0),
  returns: integer("returns").notNull().default(0),
  netRevenueUsd: real("net_revenue_usd").notNull().default(0),
  grossRevenueUsd: real("gross_revenue_usd").notNull().default(0),
  source: text("source").notNull().default("csv_upload"), // 'csv_upload' | 'portal_fetch' | 'manual'
  batchId: text("batch_id"), // FK to steamSalesUploadBatches.id when source='csv_upload'
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  uniqueProductDateSku: uniqueIndex("steam_sales_unique").on(table.productId, table.date, table.skuGroup),
}));

export const insertSteamSalesSchema = createInsertSchema(steamSalesDaily).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSteamSalesDaily = z.infer<typeof insertSteamSalesSchema>;
export type SteamSalesDaily = typeof steamSalesDaily.$inferSelect;

// ─── Steam Sales Upload Batches (audit trail for CSV uploads) ───────────────
//
// Each CSV upload creates one batch row. Lets us track which upload wrote
// which sales rows (batchId FK on steam_sales_daily), and lets users see
// upload history + roll back if needed.
export const steamSalesUploadBatches = sqliteTable("steam_sales_upload_batches", {
  id: text("id").primaryKey(), // uuid or timestamp-based, generated on upload
  productId: integer("product_id").notNull(),
  filename: text("filename").notNull(),
  fileBytes: integer("file_bytes").notNull(),
  reportDateStart: text("report_date_start"), // parsed from CSV header line 2
  reportDateEnd: text("report_date_end"),
  publisherName: text("publisher_name"), // e.g. "Mad Dog Games, LLC"
  rowsParsed: integer("rows_parsed").notNull().default(0),
  rowsIngested: integer("rows_ingested").notNull().default(0),
  rowsSkipped: integer("rows_skipped").notNull().default(0),
  skippedReason: text("skipped_reason"), // JSON breakdown
  uploadedBy: text("uploaded_by"), // future: user id when auth exists
  createdAt: text("created_at").notNull(),
});

export const insertSteamSalesUploadBatchSchema = createInsertSchema(steamSalesUploadBatches).omit({
  createdAt: true,
});

export type InsertSteamSalesUploadBatch = z.infer<typeof insertSteamSalesUploadBatchSchema>;
export type SteamSalesUploadBatch = typeof steamSalesUploadBatches.$inferSelect;

// ─── Steamworks Session Cookies (for Focus portal-page fetcher) ─────────────
//
// v3.0 (2026-08-11): Stores the user's Steamworks session cookie so a
// scheduled job on the droplet can fetch pages from Focus Entertainment's
// (or any other) publisher scope that our API key can't reach.
//
// The cookie is user-scoped (typically one per Steamworks user), NOT
// per-product. Products that need portal-page ingest reference this by
// scope name (e.g. 'default').
//
// Cookies expire; last_verified_at tracks the last successful fetch so
// we can proactively surface expiration in the UI.
export const steamworksSessions = sqliteTable("steamworks_sessions", {
  id: text("id").primaryKey(), // e.g. 'default'
  cookieValue: text("cookie_value").notNull(), // raw Cookie: header value
  loggedInAs: text("logged_in_as"), // Steamworks account/email if known
  lastVerifiedAt: text("last_verified_at"),
  lastVerifiedResult: text("last_verified_result"), // 'ok' | 'expired' | 'error: ...'
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertSteamworksSessionSchema = createInsertSchema(steamworksSessions).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSteamworksSession = z.infer<typeof insertSteamworksSessionSchema>;
export type SteamworksSession = typeof steamworksSessions.$inferSelect;

// ─── PS5 Wishlist Daily ──────────────────────────────────────────────────────

export const ps5WishlistDaily = sqliteTable("ps5_wishlist_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  cumulativeCount: integer("cumulative_count").notNull().default(0),
  dailyDelta: integer("daily_delta").notNull().default(0),
  source: text("source").notNull().default("manual"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("ps5_wishlist_unique").on(table.productId, table.date),
}));

export const insertPs5WishlistSchema = createInsertSchema(ps5WishlistDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertPs5Wishlist = z.infer<typeof insertPs5WishlistSchema>;
export type Ps5WishlistDaily = typeof ps5WishlistDaily.$inferSelect;

// ─── PS5 Prepurchase Daily ───────────────────────────────────────────────────

export const ps5PrepurchaseDaily = sqliteTable("ps5_prepurchase_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  cumulativeCount: integer("cumulative_count").notNull().default(0),
  dailyDelta: integer("daily_delta").notNull().default(0),
  source: text("source").notNull().default("manual"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("ps5_prepurchase_unique").on(table.productId, table.date),
}));

export const insertPs5PrepurchaseSchema = createInsertSchema(ps5PrepurchaseDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertPs5Prepurchase = z.infer<typeof insertPs5PrepurchaseSchema>;
export type Ps5PrepurchaseDaily = typeof ps5PrepurchaseDaily.$inferSelect;

// ─── Dynamic Forecasts Daily ─────────────────────────────────────────────────

export const dynamicForecastsDaily = sqliteTable("dynamic_forecasts_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  date: text("date").notNull(),
  platform: text("platform").notNull(),
  forecastUnits: integer("forecast_units").notNull().default(0),
  steamWishlistCountUsed: integer("steam_wishlist_count_used"),
  ps5PrepurchaseCountUsed: integer("ps5_prepurchase_count_used"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDatePlatform: uniqueIndex("dynamic_forecast_unique").on(table.productId, table.date, table.platform),
}));

export const insertDynamicForecastSchema = createInsertSchema(dynamicForecastsDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertDynamicForecast = z.infer<typeof insertDynamicForecastSchema>;
export type DynamicForecastDaily = typeof dynamicForecastsDaily.$inferSelect;

// ─── PLS Milestones ──────────────────────────────────────────────────────────

export const plsMilestones = sqliteTable("pls_milestones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  category: text("category").notNull(), // core | video | press_coverage | demo_beta | promotion
  name: text("name").notNull(),
  targetDate: text("target_date"),
  actualDate: text("actual_date"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const insertPlsMilestoneSchema = createInsertSchema(plsMilestones).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export type InsertPlsMilestone = z.infer<typeof insertPlsMilestoneSchema>;
export type PlsMilestone = typeof plsMilestones.$inferSelect;

// ─── PLS Video YouTube Links ─────────────────────────────────────────────────

export const plsVideoYoutubeLinks = sqliteTable("pls_video_youtube_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  milestoneId: integer("milestone_id").notNull(),
  youtubeVideoId: text("youtube_video_id").notNull(),
  youtubeUrl: text("youtube_url").notNull(),
  channelName: text("channel_name"),
  videoTitle: text("video_title"),
  isOfficial: integer("is_official", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const insertYoutubeLinkSchema = createInsertSchema(plsVideoYoutubeLinks).omit({
  id: true,
  createdAt: true,
});

export type InsertYoutubeLink = z.infer<typeof insertYoutubeLinkSchema>;
export type YoutubeLink = typeof plsVideoYoutubeLinks.$inferSelect;

// ─── YouTube Video Daily ─────────────────────────────────────────────────────

export const youtubeVideoDaily = sqliteTable("youtube_video_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  youtubeLinkId: integer("youtube_link_id").notNull(),
  date: text("date").notNull(),
  cumulativeViews: integer("cumulative_views").notNull().default(0),
  dailyDelta: integer("daily_delta").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueLinkDate: uniqueIndex("youtube_daily_unique").on(table.youtubeLinkId, table.date),
}));

export const insertYoutubeVideoDailySchema = createInsertSchema(youtubeVideoDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertYoutubeVideoDaily = z.infer<typeof insertYoutubeVideoDailySchema>;
export type YoutubeVideoDaily = typeof youtubeVideoDaily.$inferSelect;

// ─── Forecast Revisions ─────────────────────────────────────────────────────

export const forecastRevisions = sqliteTable("forecast_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  platform: text("platform").notNull(),
  forecastUnits: integer("forecast_units").notNull().default(0),
  revisionDate: text("revision_date").notNull(),
  revisionLabel: text("revision_label"),
  createdAt: text("created_at").notNull(),
});

export const insertForecastRevisionSchema = createInsertSchema(forecastRevisions).omit({
  id: true,
  createdAt: true,
});

export type InsertForecastRevision = z.infer<typeof insertForecastRevisionSchema>;
export type ForecastRevision = typeof forecastRevisions.$inferSelect;

// ─── App Settings ───────────────────────────────────────────────────────────

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull().default(""),
  label: text("label").notNull(),
  category: text("category").notNull(), // api_keys | general
  isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertAppSettingSchema = createInsertSchema(appSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettings.$inferSelect;

// ─── Platform Mix Constants ──────────────────────────────────────────────────

export const PLATFORM_BASE_MIX: Record<string, number> = {
  "PS5": 40,
  "PC (Steam)": 33,
  "Xbox": 17,
  "Switch 2": 7,
  "Epic Games Store": 3,
};

export const ALL_PLATFORMS = ["PC (Steam)", "PS5", "Xbox", "Switch 2", "Epic Games Store"] as const;

export const GENRES = [
  "FPS", "Action Adventure", "Horror", "Simulation",
  "Driving Sim", "Narrative", "Survival", "Survival Craft", "Other"
] as const;

export const PLAYER_FORMATS = [
  { value: "co_op", label: "Co-Op" },
  { value: "multiplayer", label: "Multiplayer" },
  { value: "single_player", label: "Single Player" },
] as const;
