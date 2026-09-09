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

// ─── Saber Steam CCU Leaderboard (v1.0, 2026-09-08) ─────────────────────────
//
// Ported approach/design from howmanyareplaying.com's Steam CCU leaderboard
// (backend/src/scheduler/pollLive.js + backend/src/routes/history.js),
// scoped to only Saber's released titles (steamAppId set AND releaseDate <=
// today — same predicate as getRevenueEligibleSteamTitles() in
// server/leaderboards.ts, minus the prepurchase-active branch). Polled every
// 60 minutes by server/ccu-poll.ts.

// Hourly (or finer, per actual poll cadence) live CCU reading per title.
// `capturedAt` is a full ISO-8601 UTC timestamp (not just a date) so the
// peak-hours-of-day chart can bucket by hour.
export const ccuSnapshotsSteam = sqliteTable("ccu_snapshots_steam", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  capturedAt: text("captured_at").notNull(), // ISO-8601 UTC timestamp
  ccu: integer("ccu").notNull(),
  // Steam-wide GetGamesByConcurrentPlayers rank at capture time (1-based).
  // Null when the title wasn't in that poll's top-100 (a real API
  // limitation for niche titles — render as "unranked", not a bug). Stored
  // per-snapshot (not a separate table) since rank is only ever meaningful
  // as-of a specific poll timestamp — same cadence as ccu itself.
  globalRank: integer("global_rank"),
}, (table) => ({
  byProductCapturedAt: index("ccu_snapshots_steam_product_captured_idx").on(table.productId, table.capturedAt),
}));

export const insertCcuSnapshotSteamSchema = createInsertSchema(ccuSnapshotsSteam).omit({ id: true });
export type InsertCcuSnapshotSteam = z.infer<typeof insertCcuSnapshotSteamSchema>;
export type CcuSnapshotSteam = typeof ccuSnapshotsSteam.$inferSelect;

// One row per (product, calendar date) — GREATEST-wins rollup of that day's
// snapshots, mirroring howmanyareplaying's daily_peaks table. Powers the
// week/month/3m/6m/1y/all range views without re-scanning raw snapshots.
export const dailyPeaksSteamCcu = sqliteTable("daily_peaks_steam_ccu", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  peakDate: text("peak_date").notNull(), // YYYY-MM-DD
  peakCcu: integer("peak_ccu").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueProductDate: uniqueIndex("daily_peaks_steam_ccu_unique").on(table.productId, table.peakDate),
}));

export const insertDailyPeakSteamCcuSchema = createInsertSchema(dailyPeaksSteamCcu).omit({ id: true, createdAt: true });
export type InsertDailyPeakSteamCcu = z.infer<typeof insertDailyPeakSteamCcuSchema>;
export type DailyPeakSteamCcu = typeof dailyPeaksSteamCcu.$inferSelect;

// Single-row (id=1) job-state tracker for the 60-minute poll, following the
// same shape as steamworksSessions' auto-refresh columns. `lastPolledAt`
// drives the leaderboard's countdown timer (mirrors howmanyareplaying's
// CountdownTimer, which ticks down from `lastUpdatedAt` to the next poll).
export const ccuPollState = sqliteTable("ccu_poll_state", {
  id: integer("id").primaryKey(),
  lastPolledAt: text("last_polled_at"),
  lastPollResult: text("last_poll_result"), // "success" | "error: <message>"
  titlesPolled: integer("titles_polled"),
  updatedAt: text("updated_at"),
});

export type CcuPollState = typeof ccuPollState.$inferSelect;

// One row per product — cached IGDB media (screenshots/videos/summary),
// refreshed daily alongside the existing hype ingestion. Ported field list
// from howmanyareplaying/backend/src/services/igdbApi.js
// (screenshots.image_id, videos.video_id, summary), same
// external_game_source=1 Steam-appid matching rule as server/igdb.ts's
// existing fetchIgdbHypesBySteamAppids.
export const igdbMediaCache = sqliteTable("igdb_media_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }).unique(),
  igdbId: integer("igdb_id"),
  summary: text("summary"),
  screenshotIds: text("screenshot_ids"), // JSON string[] of IGDB image_ids
  videoIds: text("video_ids"), // JSON string[] of YouTube video_ids
  updatedAt: text("updated_at").notNull(),
});

export const insertIgdbMediaCacheSchema = createInsertSchema(igdbMediaCache).omit({ id: true });
export type InsertIgdbMediaCache = z.infer<typeof insertIgdbMediaCacheSchema>;
export type IgdbMediaCache = typeof igdbMediaCache.$inferSelect;

// "Top 5 Steam crossover games" — ported v5 algorithm (Valve morelike +
// SteamHunters achievement-completion scoring + franchise dedupe + MMR
// selection) from howmanyareplaying/backend/src/services/steamApi.js
// (fetchRelatedGames) and its monthly precompute cron
// (backend/src/scheduler/pollRelatedGames.js). `position` is 1-based (1-5).
export const relatedGamesSteamHunters = sqliteTable("related_games_steamhunters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  relatedAppid: integer("related_appid").notNull(),
  relatedName: text("related_name").notNull(),
  headerImage: text("header_image"),
  playerCount: integer("player_count"), // SteamHunters achievement-hunter panel size
  tags: text("tags"), // JSON string[] of up to 5 tag names
  computedAt: text("computed_at").notNull(),
}, (table) => ({
  uniqueProductPosition: uniqueIndex("related_games_steamhunters_unique").on(table.productId, table.position),
}));

export const insertRelatedGamesSteamHuntersSchema = createInsertSchema(relatedGamesSteamHunters).omit({ id: true });
export type InsertRelatedGamesSteamHunters = z.infer<typeof insertRelatedGamesSteamHuntersSchema>;
export type RelatedGamesSteamHunters = typeof relatedGamesSteamHunters.$inferSelect;

// Single-row (id=1) meta tracker for the monthly related-games precompute,
// mirroring howmanyareplaying's related_games_meta table.
export const relatedGamesSteamHuntersMeta = sqliteTable("related_games_steamhunters_meta", {
  id: integer("id").primaryKey(),
  lastRefreshStartedAt: text("last_refresh_started_at"),
  lastRefreshCompletedAt: text("last_refresh_completed_at"),
  nextRefreshAt: text("next_refresh_at"),
  titlesProcessed: integer("titles_processed"),
  titlesSkipped: integer("titles_skipped"),
});

export type RelatedGamesSteamHuntersMeta = typeof relatedGamesSteamHuntersMeta.$inferSelect;

// "Popular Upcoming" — related UNRELEASED Steam titles for a CCU PDP,
// distinct from relatedGamesSteamHunters above (which is already-released
// crossover titles only). Sourced from Valve's official
// IStoreQueryService/MoreLikeThis/v1 with filters.coming_soon_only=true
// (server/ccu-upcoming.ts) — no SteamHunters scoring, since unreleased
// titles have no player/achievement stats yet; picks are Valve's own
// relevance order after franchise-dedupe. `position` is 1-based (1-5).
export const relatedGamesUpcoming = sqliteTable("related_games_upcoming", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  relatedAppid: integer("related_appid").notNull(),
  relatedName: text("related_name").notNull(),
  headerImage: text("header_image"),
  releaseDisplay: text("release_display"), // e.g. "Coming soon", "To be announced", or a formatted date
  computedAt: text("computed_at").notNull(),
}, (table) => ({
  uniqueProductPosition: uniqueIndex("related_games_upcoming_unique").on(table.productId, table.position),
}));

export const insertRelatedGamesUpcomingSchema = createInsertSchema(relatedGamesUpcoming).omit({ id: true });
export type InsertRelatedGamesUpcoming = z.infer<typeof insertRelatedGamesUpcomingSchema>;
export type RelatedGamesUpcoming = typeof relatedGamesUpcoming.$inferSelect;

// Single-row (id=1) meta tracker for the monthly "Popular Upcoming"
// precompute, mirroring relatedGamesSteamHuntersMeta above.
export const relatedGamesUpcomingMeta = sqliteTable("related_games_upcoming_meta", {
  id: integer("id").primaryKey(),
  lastRefreshStartedAt: text("last_refresh_started_at"),
  lastRefreshCompletedAt: text("last_refresh_completed_at"),
  nextRefreshAt: text("next_refresh_at"),
  titlesProcessed: integer("titles_processed"),
  titlesSkipped: integer("titles_skipped"),
});

export type RelatedGamesUpcomingMeta = typeof relatedGamesUpcomingMeta.$inferSelect;

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

// ─── Amazon Retail App (2026-09-06) ─────────────────────────────────────────
//
// Rainforest-API-fed retail intelligence: chart positions, Buy Box monitor,
// reviews pulse, movers & shakers, search SOV, new-release watch. Powers the
// third tab of Leaderboards ("Saber Amazon Leaderboard") and a full top-level
// Amazon Retail app. Ingested nightly via startAmazonIngestionCron().
//
// Design notes:
// - Platforms in this module are the short slugs "ps5" | "xbox" | "switch"
//   (NOT the ALL_PLATFORMS strings). Charts on amazon.com use one URL per
//   platform browse node, so we key everything by these slugs.
// - Snapshots are immutable daily rows keyed on (snapshot_date, platform,
//   asin) or (snapshot_date, platform, rank) — delta engine reads history
//   backwards from today to compute 1d / 7d / 30d rank movement.
// - amazonAsinMap links a SignalPulse product_id to per-platform ASINs.
//   Rows can be auto-discovered (is_auto=true) or user-overridden
//   (is_auto=false). The unique index prevents duplicate mappings per
//   (product_id, platform).

export const AMAZON_PLATFORM_SLUGS = ["ps5", "xbox", "switch"] as const;
export type AmazonPlatformSlug = typeof AMAZON_PLATFORM_SLUGS[number];

// Amazon.com bestseller browse nodes (US marketplace). Node IDs and canonical
// URLs, both consumed by the Rainforest client. Switch 2 does NOT have a
// distinct zgbs node yet — Switch 2 titles live inside the general Nintendo
// Switch Games chart. UI opts to filter Switch results by SKU strings that
// indicate a Switch 2 edition ("Nintendo Switch 2", "- Switch 2", etc.).
export const AMAZON_CHART_NODES: Record<AmazonPlatformSlug, { name: string; url: string; nodeId: string }> = {
  // v3.40 (2026-09-08): switched from parent umbrella node 20972781011
  // ("PlayStation 5 Consoles, Games & Accessories") to the games-only
  // node 20972797011 ("PlayStation 5 Games"). The umbrella node's top-50
  // is ~60% hardware/controllers/HDMI cables/etc., so after
  // isVideoGameSoftware filtering only ~20 games survived per snapshot,
  // while Xbox and Switch (already on games-only nodes) yielded ~48-50.
  // This aligns PS5 leaderboard depth with the other two platforms.
  ps5:    { name: "PlayStation 5 Games",   nodeId: "20972797011", url: "https://www.amazon.com/Best-Sellers-PlayStation-5-Games/zgbs/videogames/20972797011/" },
  xbox:   { name: "Xbox Series X|S Games", nodeId: "20972814011", url: "https://www.amazon.com/Best-Sellers-Xbox-Series-X-S-Games/zgbs/videogames/20972814011/" },
  switch: { name: "Nintendo Switch Games", nodeId: "16227133011", url: "https://www.amazon.com/Best-Sellers-Nintendo-Switch-Games/zgbs/videogames/16227133011/" },
};

// Product ↔ ASIN mapping per platform. products.id → asin per platform slug.
// is_auto=true means Rainforest search discovered it; is_auto=false means the
// user pinned it via the /api/amazon/asin-map POST endpoint. is_switch2 is a
// per-row flag set when the auto-discovered Switch ASIN is a Switch 2 SKU
// (used by the UI to show a "Switch 2" pill vs. "Switch").
// Competitor titles from SentimentPulse (games with a parent Saber title in
// the competitor_games join table). Kept in a separate table from
// amazon_asin_map so the Saber-owned discovery path stays clean, and so a
// competitor pin's parent linkage is explicit (parentProductId).
// sentimentpulseGameId is the FK into sentimentpulse.games.id and doubles
// as the natural key for daily sync from SentimentPulse.
export const amazonCompetitorAsinMap = sqliteTable("amazon_competitor_asin_map", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sentimentpulseGameId: integer("sentimentpulse_game_id").notNull(),
  parentProductId: integer("parent_product_id").notNull(), // SignalPulse products.id of the Saber parent
  name: text("name").notNull(),
  steamAppId: integer("steam_app_id"),
  platform: text("platform").notNull(), // ps5 | xbox | switch
  asin: text("asin").notNull(),
  isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(true),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  matchScore: real("match_score"), // 0-1 confidence when auto-discovered
  discoveredAt: text("discovered_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  uniqueGamePlatform: uniqueIndex("amazon_competitor_asin_map_unique_game_platform").on(table.sentimentpulseGameId, table.platform),
  byParentIdx: index("amazon_competitor_asin_map_by_parent_idx").on(table.parentProductId),
}));

export const amazonAsinMap = sqliteTable("amazon_asin_map", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  platform: text("platform").notNull(), // ps5 | xbox | switch
  asin: text("asin").notNull(),
  isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(true),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  isSwitch2: integer("is_switch2", { mode: "boolean" }).notNull().default(false),
  matchScore: real("match_score"), // 0-1 confidence when auto-discovered
  discoveredAt: text("discovered_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  uniquePlatform: uniqueIndex("amazon_asin_map_unique_product_platform").on(table.productId, table.platform),
  productIdx: index("amazon_asin_map_product_idx").on(table.productId),
}));

// Daily chart snapshot per platform. One row per (date, platform, rank).
// items is the full Rainforest raw JSON for the row (title, ASIN, price,
// rating, ratings_total, image, link). Delta engine joins today's row for a
// given ASIN with yesterday/7-day-ago/30-day-ago rows to compute movement.
// Daily chart snapshot per platform (SOFTWARE ONLY — hardware/peripherals
// filtered out at ingest time by isVideoGameSoftware(); see
// server/amazon-rainforest.ts). rank is the CONTIGUOUS 1..N software-only
// rank we present in the UI; rawRank preserves Amazon's original position
// so the source of truth is auditable (e.g. "we ranked this #5, Amazon
// showed it at #7 because two headsets ranked above it").
export const amazonChartSnapshots = sqliteTable("amazon_chart_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD (UTC)
  platform: text("platform").notNull(), // ps5 | xbox | switch
  rank: integer("rank").notNull(), // contiguous software-only rank
  rawRank: integer("raw_rank"), // Amazon's original rank before software filter
  asin: text("asin").notNull(),
  title: text("title").notNull(),
  price: real("price"),
  rating: real("rating"),
  ratingsTotal: integer("ratings_total"),
  imageUrl: text("image_url"),
  link: text("link"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDayPlatformRank: uniqueIndex("amazon_chart_snap_unique_day_platform_rank").on(table.snapshotDate, table.platform, table.rank),
  byAsinIdx: index("amazon_chart_snap_by_asin_idx").on(table.asin, table.snapshotDate),
}));

// "Also Bought" recommendations per tracked ASIN. Rainforest type=product
// returns an also_bought[] array on many ASINs; we pull top 5 weekly (per
// tracked ASIN; both Saber and comp titles). Refresh is weekly, not daily,
// because this data changes slowly and per-ASIN Product calls cost credits.
// (sourceAsin, recommendedAsin) pair is unique per snapshotDate.
export const amazonAlsoBoughtDaily = sqliteTable("amazon_also_bought_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  sourceAsin: text("source_asin").notNull(),
  rankPosition: integer("rank_position").notNull(), // 1..5
  recommendedAsin: text("recommended_asin").notNull(),
  title: text("title").notNull(),
  price: real("price"),
  rating: real("rating"),
  ratingsTotal: integer("ratings_total"),
  mainBsr: integer("main_bsr"),
  imageUrl: text("image_url"),
  link: text("link"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDaySourcePos: uniqueIndex("amazon_also_bought_unique_day_source_pos").on(table.snapshotDate, table.sourceAsin, table.rankPosition),
  bySourceIdx: index("amazon_also_bought_by_source_idx").on(table.sourceAsin, table.snapshotDate),
}));

// Per-SKU daily Product endpoint pull. Powers the Buy Box & Availability
// Monitor and the Reviews Pulse sub-apps. Missing fields are OK — the ingest
// job stores whatever Rainforest returns and the UI tolerates nulls.
export const amazonProductDaily = sqliteTable("amazon_product_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  asin: text("asin").notNull(),
  buyboxPrice: real("buybox_price"),
  buyboxSeller: text("buybox_seller"),
  buyboxIsAmazon: integer("buybox_is_amazon", { mode: "boolean" }),
  isPrime: integer("is_prime", { mode: "boolean" }),
  stockStatus: text("stock_status"), // in_stock | low_stock | out_of_stock | preorder | unknown
  mainBsr: integer("main_bsr"),
  subBsrsJson: text("sub_bsrs_json"), // JSON: [{category, rank}]
  rating: real("rating"),
  ratingsTotal: integer("ratings_total"),
  // "Bought in past month" label surfaced on the product / search cards.
  // Rainforest returns the raw display string (e.g. "100+ bought in past
  // month", "1K+ bought in past week"). Only present on high-velocity SKUs
  // — nulls are normal.
  recentSales: text("recent_sales"),
  // Rainforest sales_estimation output. Populated by the daily
  // sales_estimation job that runs after `products`. Nulls when the ASIN
  // has no BSR (pre-orders) or ranks too low to model. Estimates track
  // the BSR at the time of estimation, stored separately from mainBsr
  // so we can spot stale estimates.
  monthlySalesEstimate: integer("monthly_sales_estimate"),
  weeklySalesEstimate: integer("weekly_sales_estimate"),
  salesEstimateBsr: integer("sales_estimate_bsr"),
  salesEstimateCategory: text("sales_estimate_category"),
  // v3.37 (2026-09-07): captured from the same type=product response so the
  // PDP header renders even when the ASIN isn't in any chart snapshot.
  title: text("title"),
  imageUrl: text("image_url"),
  link: text("link"),
  // v3.38 (2026-09-07): top reviews array (up to 20) captured from the
  // same type=product response. Replaces the deprecated type=reviews
  // endpoint (Amazon killed the "Most Recent" reviews sort in March 2025
  // and Rainforest deprecated /reviews v2 in response). JSON array of
  // {reviewId,title,body,rating,reviewDate,verifiedPurchase,helpfulVotes,
  //  reviewerName,variantAttrs,imageUrls} per docs.trajectdata.com.
  topReviewsJson: text("top_reviews_json"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDayAsin: uniqueIndex("amazon_product_daily_unique_day_asin").on(table.snapshotDate, table.asin),
}));

// Movers & Shakers: Amazon's own 24hr rank-gainers chart per platform.
export const amazonMoversDaily = sqliteTable("amazon_movers_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  platform: text("platform").notNull(),
  rank: integer("rank").notNull(),
  asin: text("asin").notNull(),
  title: text("title").notNull(),
  rankChange: integer("rank_change"), // % or absolute change reported by Amazon
  imageUrl: text("image_url"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDayPlatformRank: uniqueIndex("amazon_movers_unique_day_platform_rank").on(table.snapshotDate, table.platform, table.rank),
}));

// Franchise keyword tracker for Search SOV. keyword is the raw query.
// results is a JSON list of the top ~10 positions returned by Rainforest
// Search API (each entry: {rank, asin, title, is_sponsored}). Delta on
// tracked SKU position is computed in the UI.
export const amazonKeywordDaily = sqliteTable("amazon_keyword_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  keyword: text("keyword").notNull(),
  resultsJson: text("results_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDayKeyword: uniqueIndex("amazon_keyword_unique_day_keyword").on(table.snapshotDate, table.keyword),
}));

// New Releases chart per platform. first_seen_date lets us alert on
// competitor drops we haven't yet added to the tracker.
export const amazonNewReleases = sqliteTable("amazon_new_releases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  platform: text("platform").notNull(),
  rank: integer("rank").notNull(),
  asin: text("asin").notNull(),
  title: text("title").notNull(),
  firstSeenDate: text("first_seen_date"),
  imageUrl: text("image_url"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDayPlatformRank: uniqueIndex("amazon_new_releases_unique_day_platform_rank").on(table.snapshotDate, table.platform, table.rank),
}));

// Cron run log for observability (Settings → Diagnostics can surface this).
export const amazonIngestRuns = sqliteTable("amazon_ingest_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobName: text("job_name").notNull(), // charts | products | movers | keywords | new_releases | asin_discovery
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(), // running | ok | error
  creditsUsed: integer("credits_used"),
  creditsRemaining: integer("credits_remaining"),
  rowsWritten: integer("rows_written"),
  errorMessage: text("error_message"),
});

// v3.36 (2026-09-07): Per-ASIN review snapshots. Populated on-demand from
// the PDP Reviews tab (and by any future review-pulse ingest). We store
// one row per Amazon review id per ASIN — the same review may be updated
// (helpful_votes / body edited) but the (asin, review_id) pair is unique.
// Rainforest returns review_id, title, body, rating, date (ISO or free-
// text), verified_purchase, helpful_votes, profile.name, and images[].
// Everything is nullable because Amazon omits fields on international
// storefronts and older reviews.
// Per-ASIN related-product surface written by runProductSnapshots — zero
// additional Rainforest calls. `kind` discriminates rows: `variant` rows
// carry related_asin/title/image_url/link (cross-platform siblings from
// product.variants[]); `category_rank` rows carry category_name +
// category_rank + link (bestseller rank entries from product.bestsellers_rank[]).
// Same-day upsert keyed on (source_asin, snapshot_date, kind, rank_position).
// Replaces the deprecated amazon_also_bought_daily surface (Rainforest returns
// nothing for game ASINs; see lessons.md 2026-09-07).
export const amazonProductRelatedDaily = sqliteTable("amazon_product_related_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotDate: text("snapshot_date").notNull(),
  sourceAsin: text("source_asin").notNull(),
  kind: text("kind").notNull(), // 'variant' | 'category_rank'
  rankPosition: integer("rank_position").notNull(),
  relatedAsin: text("related_asin"),
  title: text("title"),
  imageUrl: text("image_url"),
  link: text("link"),
  categoryName: text("category_name"),
  categoryRank: integer("category_rank"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueDaySourceKindPos: uniqueIndex("amazon_product_related_unique_day_source_kind_pos").on(table.snapshotDate, table.sourceAsin, table.kind, table.rankPosition),
  bySourceIdx: index("amazon_product_related_by_source_idx").on(table.sourceAsin, table.snapshotDate),
}));

export const amazonProductReviews = sqliteTable("amazon_product_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  asin: text("asin").notNull(),
  reviewId: text("review_id").notNull(),
  title: text("title"),
  body: text("body"),
  rating: real("rating"),
  reviewDate: text("review_date"), // Amazon's raw "Reviewed in the United States on X" or ISO
  verifiedPurchase: integer("verified_purchase", { mode: "boolean" }),
  helpfulVotes: integer("helpful_votes"),
  reviewerName: text("reviewer_name"),
  variantAttrsJson: text("variant_attrs_json"), // JSON: e.g. [{name:"Platform", value:"PlayStation 5"}]
  imageUrlsJson: text("image_urls_json"), // JSON: string[]
  fetchedAt: text("fetched_at").notNull(), // when we pulled this row from Rainforest
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniqueAsinReview: uniqueIndex("amazon_product_reviews_unique_asin_review").on(table.asin, table.reviewId),
}));

export type AmazonAsinMap = typeof amazonAsinMap.$inferSelect;
export type AmazonChartSnapshot = typeof amazonChartSnapshots.$inferSelect;
export type AmazonProductDaily = typeof amazonProductDaily.$inferSelect;
export type AmazonMoversDaily = typeof amazonMoversDaily.$inferSelect;
export type AmazonKeywordDaily = typeof amazonKeywordDaily.$inferSelect;
export type AmazonNewReleases = typeof amazonNewReleases.$inferSelect;
export type AmazonAlsoBoughtDaily = typeof amazonAlsoBoughtDaily.$inferSelect;
export type AmazonIngestRun = typeof amazonIngestRuns.$inferSelect;
export type AmazonProductReview = typeof amazonProductReviews.$inferSelect;
