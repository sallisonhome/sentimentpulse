import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
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
  // v3.14 (2026-08-12): cached from Steam's public appdetails API
  // (header_image field) so the leaderboard doesn't rely on the fragile
  // synthesized cdn.cloudflare.steamstatic.com path, which 404s for
  // titles Steam migrated to hashed Akamai asset paths (see
  // server/steam-header-image.ts). Null until the first ingestion run
  // populates it; leaderboards.ts falls back to the synthesized URL.
  steamHeaderImageUrl: text("steam_header_image_url"),
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

// ─── Steam Sales By Country (period aggregates from portal HTML) ───────────
//
// v3.30 (2026-09-05): Powers the Sales-by-Country pages on SignalPulse
// (top-nav) and Promo Calendar (PDP). Populated by extending the same
// portal-HTML fetch that already runs daily (via steamworks-portal.ts) —
// no new external calls: the country panels are on the SAME page we
// already download for units + revenue.
//
// The Steamworks portal returns TOTALS for whatever date range is in the
// URL. So each row represents "country X's units + revenue across the
// period [period_start, period_end]". Historical backfill writes
// granularity='month' rows (one fetch per month per product); the daily
// portal cron continues to write granularity='day' rows for the previous
// day. Both live in this table; the API sums whichever rows overlap the
// requested range and prefers finer granularity when both are present.
//
// Uniqueness key locked at (product_id, period_start, period_end,
// country_iso) — re-fetching the same range is a no-op upsert.
export const steamSalesByCountryPeriod = sqliteTable(
  "steam_sales_by_country_period",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id").notNull(),
    // Inclusive ISO date bounds. For granularity='day' both equal the same
    // date; for 'month' they're the first + last day of the calendar month.
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    // 'day' | 'month' | 'custom'. The API prefers day > month > custom
    // when overlapping rows exist for the same date range.
    granularity: text("granularity").notNull().default("month"),
    // ISO-3166 alpha-2 code as parsed from Steamworks portal country_code
    // params (US, CA, DE, JP, CN, etc.). Uppercase. Empty string when the
    // portal reports an 'Unknown' row (rare, kept so totals reconcile).
    countryIso: text("country_iso").notNull(),
    // Human-readable name as rendered by Steamworks (e.g. 'United States').
    // Cached so the UI doesn't need a separate ISO→name lookup.
    countryName: text("country_name").notNull(),
    // Steam units + revenue for this country over this period.
    units: integer("units").notNull().default(0),
    revenueUsd: real("revenue_usd").notNull().default(0),
    // Retail (CD-key) activations for this country over this period. Kept
    // separate from units so the UI can show pure Steam sales cleanly.
    activations: integer("activations").notNull().default(0),
    activationRevenueUsd: real("activation_revenue_usd").notNull().default(0),
    // v3.32 (2026-09-05): SHARE columns — primary source of truth for
    // country-level splits. 0..1 fractions (0.419 = 41.9%). Nullable
    // because rows written before v3.32 don't have them; when null, the
    // API falls back to computing shares from units/revenue_usd.
    // Consumers should compute per-country revenue as
    //   pctOfRevenue * <authoritative steam_sales_daily total for window>
    // to avoid parseNumericCell's K/M suffix truncation bug on the raw
    // dollar cells.
    pctOfUnits: real("pct_of_units"),
    pctOfRevenue: real("pct_of_revenue"),
    source: text("source").notNull().default("portal_fetch"),
    fetchedAt: text("fetched_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    uniquePeriodCountry: uniqueIndex("steam_sales_country_unique").on(
      table.productId,
      table.periodStart,
      table.periodEnd,
      table.countryIso,
    ),
    productPeriodIdx: index("steam_sales_country_by_product_period").on(
      table.productId,
      table.periodStart,
      table.periodEnd,
    ),
  }),
);

export const insertSteamSalesByCountrySchema = createInsertSchema(
  steamSalesByCountryPeriod,
).omit({
  id: true,
  fetchedAt: true,
  updatedAt: true,
});

export type InsertSteamSalesByCountry = z.infer<typeof insertSteamSalesByCountrySchema>;
export type SteamSalesByCountry = typeof steamSalesByCountryPeriod.$inferSelect;

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
  // Set when a proactive expiry-alert email has been sent for the CURRENT
  // failure episode; cleared back to null on the next successful verify
  // (or on a fresh cookie save) so the next expiry re-alerts immediately
  // instead of staying silent forever. See server/ingestion.ts ingestSteamSales().
  alertSentAt: text("alert_sent_at"),
  // v3.18 (2026-08-14): provenance + health tracking for the agent-driven
  // cookie auto-refresh flow (Perplexity agent pulls the live Steamworks
  // session cookie from the user's local browser via CDP and pushes it
  // here — either on-demand or from a scheduled nightly self-heal check).
  // 'refreshSource' records how the CURRENTLY STORED cookie got here;
  // the auto_refresh_last_* fields track the most recent auto-refresh
  // ATTEMPT regardless of whether it resulted in a saved cookie (e.g. a
  // failed attempt because no browser was reachable still gets logged).
  refreshSource: text("refresh_source"), // 'manual' | 'agent_on_demand' | 'agent_scheduled'
  autoRefreshLastAttemptAt: text("auto_refresh_last_attempt_at"),
  autoRefreshLastResult: text("auto_refresh_last_result"), // 'success' | 'no_browser_available' | 'steam_session_also_expired' | 'test_fetch_failed: ...'
  // v3.19 (2026-08-14): a webpage button can't itself trigger the agent's
  // browser automation, so this is a request flag, not a live trigger --
  // set when the user clicks "Request agent refresh" in Settings, cleared
  // whenever a fresh cookie is saved (any refreshSource). The nightly
  // self-heal check also reads this so a manual request gets picked up
  // even if the user doesn't happen to ask in chat first.
  refreshRequestedAt: text("refresh_requested_at"),
  // v3.20 (2026-08-17): long-lived Steam refresh token (`steamRefresh_partner`
  // cookie value, ~200-day lifetime) used to silently mint a fresh
  // steamLoginSecure access cookie via the login.steampowered.com/jwt/
  // ajaxrefresh + partner.steampowered.com/login/settoken HTTP flow --
  // no browser/Playwright required for the recurring refresh. Captured
  // once from the user's logged-in browser session; NEVER returned by any
  // GET endpoint (see /api/steam/session below -- only a boolean +
  // preview length are exposed).
  refreshTokenValue: text("refresh_token_value"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const insertSteamworksSessionSchema = createInsertSchema(steamworksSessions).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSteamworksSession = z.infer<typeof insertSteamworksSessionSchema>;
export type SteamworksSession = typeof steamworksSessions.$inferSelect;

// ─── Steam Followers Daily (Steam Leaderboards — Wishlist board) ───────────
//
// v1.0 (2026-08-12): supports the Saber Pre-Release Steam Wishlist
// Leaderboard. Sourced EXCLUSIVELY from the public
// steamcommunity.com/games/<appid>/memberslistxml scrape, ported verbatim
// from howmanyareplaying/backend/src/services/steamApi.js::fetchFollowerCount
// (see CLAUDE_STEAM_LEADERBOARDS.md §9.2) — there is no Steamworks Partner
// API endpoint for follower counts, confirmed against Valve's own docs.
// `source` is always "public_scrape"; kept as a column (rather than a
// hardcoded constant) only so a future alternate source doesn't require a
// migration.
//
// followerCount/dailyDelta are NULLABLE: on a fetch failure (429 exhausted,
// 404/403, parse miss) ingestSteamFollowers() still writes a row for
// today's date with both null, so the title doesn't get retried again
// until tomorrow's run — see server/ingestion.ts::ingestSteamFollowers.
// The UI renders null as "—", never 0.
export const steamFollowersDaily = sqliteTable("steam_followers_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD, local ingestion-run date
  followerCount: integer("follower_count"), // null = fetch failed today
  dailyDelta: integer("daily_delta"), // signed; NOT clamped to >= 0; null when followerCount is null
  source: text("source").notNull().default("public_scrape"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("steam_followers_unique").on(table.productId, table.date),
}));

export const insertSteamFollowersSchema = createInsertSchema(steamFollowersDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertSteamFollowers = z.infer<typeof insertSteamFollowersSchema>;
export type SteamFollowersDaily = typeof steamFollowersDaily.$inferSelect;

// ─── Steam Wishlist Rank Daily (Steam Leaderboards — Wishlist board) ───────
//
// v1.0 (2026-08-12): current position (1-based) on Steam's public
// "popularwishlist" upcoming-titles listing, ported from
// howmanyareplaying/backend/src/services/steamApi.js::fetchWishlistedGames
// with the SAME constants (PAGE_SIZE=25, MAX_PAGES=12, TARGET=200) — see
// CLAUDE_STEAM_LEADERBOARDS.md §9.5. `rank` is null when a tracked title is
// outside the top-200 that day ("unranked"), NOT an error state. No SteamDB
// fallback — howmanyareplaying never needed one in production.
export const steamWishlistRankDaily = sqliteTable("steam_wishlist_rank_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  rank: integer("rank"), // null = outside top-200 that day
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("steam_wishlist_rank_unique").on(table.productId, table.date),
}));

export const insertSteamWishlistRankSchema = createInsertSchema(steamWishlistRankDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertSteamWishlistRank = z.infer<typeof insertSteamWishlistRankSchema>;
export type SteamWishlistRankDaily = typeof steamWishlistRankDaily.$inferSelect;

// ─── IGDB Hype Daily (Steam Leaderboards — Wishlist board) ─────────────────
//
// v1.0 (2026-08-12): IGDB's `hypes` field (pre-release follower count on
// IGDB itself), ported from howmanyareplaying's igdbApi.js batched-POST
// pattern (Twitch OAuth client-credentials, external_games Steam-appid
// match, up to 200 appids/request). `igdbId` is persisted so future PDP
// surfaces don't need a second lookup; `hypeScore` is null when IGDB has no
// matching record for the title's steamAppId (rendered as —, never 0).
export const igdbHypeDaily = sqliteTable("igdb_hype_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  igdbId: integer("igdb_id"), // null when IGDB has no match for this title
  hypeScore: integer("hype_score"), // null, never 0-as-placeholder
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("igdb_hype_unique").on(table.productId, table.date),
}));

export const insertIgdbHypeSchema = createInsertSchema(igdbHypeDaily).omit({
  id: true,
  createdAt: true,
});

export type InsertIgdbHype = z.infer<typeof insertIgdbHypeSchema>;
export type IgdbHypeDaily = typeof igdbHypeDaily.$inferSelect;

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

// ─── Launch Forecast Snapshot (v3.22) ────────────────────────────────────────
//
// One row per product. Written exactly once, the first time the dashboard
// route observes releaseDate <= today. Locks in the wishlist-driven dynamic
// forecast (per-platform: firstMonth / firstYear / lifetime) computed from
// preLaunchNet at release-day, plus the total-across-all-platforms rollups
// and the Steam-only rollups so the card can render Baseline / Current /
// Delta without any recomputation.
//
// Never rewritten after creation — the whole point is that this number is
// the immortal launch-day baseline. Post-release the card compares live
// (actuals-influenced) forecasts to this locked baseline until T+365 days
// past release, when the baseline is hidden from the card (data stays in
// the table for historical review).

export const launchForecastSnapshots = sqliteTable("launch_forecast_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  // The date on which the snapshot was captured (ISO YYYY-MM-DD, UTC).
  // Normally equals the product's releaseDate but could be later if the
  // dashboard wasn't hit until N days after launch — we still capture the
  // preLaunchNet at that moment (which is already locked and immutable).
  snapshotDate: text("snapshot_date").notNull(),
  // The Steam preLaunchNet wishlist count that fed the forecast — recorded
  // so future audits can reconstruct exactly what the multiplier was applied to.
  steamWishlistCountAtLaunch: integer("steam_wishlist_count_at_launch"),
  // Rollup totals across ALL selected platforms.
  totalFirstMonth: integer("total_first_month").notNull(),
  totalFirstYear: integer("total_first_year").notNull(),
  totalLifetime: integer("total_lifetime").notNull(),
  // Steam-only slice (denormalized for card convenience).
  steamFirstMonth: integer("steam_first_month"),
  steamFirstYear: integer("steam_first_year"),
  steamLifetime: integer("steam_lifetime"),
  // v3.32 (2026-08-19): the PS5 prepurchase count that fed the PS5 side of
  // this snapshot's forecast (mirrors steamWishlistCountAtLaunch above).
  // Stored so the Bull(.45)/Bear(.18) scenario toggle can recompute an
  // alternate scenario at read time from the SAME locked inputs, without a
  // second DB write. Null when the product has no PS5 prepurchase signal.
  ps5PrepurchaseCountAtLock: integer("ps5_prepurchase_count_at_lock"),
  // Full per-platform DynamicForecastResult array (JSON):
  //   [{platform: 'PC (Steam)', firstMonth, firstYear, lifetime}, ...]
  perPlatformForecastsJson: text("per_platform_forecasts_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProduct: uniqueIndex("launch_forecast_unique_product").on(table.productId),
}));

export const insertLaunchForecastSnapshotSchema = createInsertSchema(launchForecastSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertLaunchForecastSnapshot = z.infer<typeof insertLaunchForecastSnapshotSchema>;
export type LaunchForecastSnapshot = typeof launchForecastSnapshots.$inferSelect;

// ─── Wishlist Conversion Benchmark (v3.33) ──────────────────────────────────
//
// PDP "Pre-Release Wishlist → Units Sold Conversion" card metrics.
// Metric 1 (LTD conversion, 6mo+ post-release) is computed LIVE at request
// time from existing data (steamActualCumulativeUnits ÷ preLaunchNet) and
// needs no storage — see the PDP handler in server/routes.ts. Metric 2
// (Day-30 conversion benchmark) must be LOCKED forever the first time the
// day-30 window closes, so it needs this table. Written exactly once per
// product, the first time lockWishlistConversionBenchmarks()
// (server/ingestion.ts) observes getSteamActualFirstMonthBaseUnits()
// returning non-null AND a non-null pre-release wishlist count. Never
// rewritten after that — mirrors the launchForecastSnapshots pattern above.
export const wishlistConversionBenchmarks = sqliteTable("wishlist_conversion_benchmarks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  // The pre-release wishlist count (steamWishlistSummary.preLaunchNet) used
  // as the denominator — recorded so future audits can reconstruct exactly
  // what the locked percentage was computed against.
  preReleaseWishlistCount: integer("pre_release_wishlist_count").notNull(),
  // Base-game net units sold in [releaseDate, releaseDate+30d) — the fixed
  // window getSteamActualFirstMonthBaseUnits() sums.
  day30BaseUnitsSold: integer("day30_base_units_sold").notNull(),
  // day30BaseUnitsSold ÷ preReleaseWishlistCount × 100, rounded to 2 decimals.
  day30ConversionPct: real("day30_conversion_pct").notNull(),
  // ISO YYYY-MM-DD date this benchmark was locked (normally releaseDate+30
  // days, but could be later if ingestion wasn't run exactly on that day).
  lockedAt: text("locked_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProduct: uniqueIndex("wishlist_conversion_benchmark_unique_product").on(table.productId),
}));

export const insertWishlistConversionBenchmarkSchema = createInsertSchema(wishlistConversionBenchmarks).omit({
  id: true,
  createdAt: true,
});

export type InsertWishlistConversionBenchmark = z.infer<typeof insertWishlistConversionBenchmarkSchema>;
export type WishlistConversionBenchmark = typeof wishlistConversionBenchmarks.$inferSelect;

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

// ─── Leaderboard Weekly Email Recipients ─────────────────────────────────────
// A managed list, not a comma-separated appSettings string — lets Settings offer
// real add/remove controls instead of hand-editing text, and lets us pause a
// recipient without losing their record. See CLAUDE_STEAM_LEADERBOARDS.md §2/§8.1.
export const leaderboardEmailRecipients = sqliteTable("leaderboard_email_recipients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  label: text("label"), // optional display name, e.g. "Steve Allison"
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueEmail: uniqueIndex("leaderboard_recipients_unique_email").on(table.email),
}));

export const insertLeaderboardEmailRecipientSchema = createInsertSchema(leaderboardEmailRecipients).omit({
  id: true,
  createdAt: true,
});

export type InsertLeaderboardEmailRecipient = z.infer<typeof insertLeaderboardEmailRecipientSchema>;
export type LeaderboardEmailRecipient = typeof leaderboardEmailRecipients.$inferSelect;

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
