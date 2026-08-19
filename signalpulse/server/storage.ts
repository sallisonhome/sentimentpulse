import {
  type Product, type InsertProduct, products,
  type ForecastComps, type InsertForecastComps, productForecastsComps,
  type SteamWishlistDaily, type InsertSteamWishlist, steamWishlistDaily,
  type SteamWishlistReportingDaily, type InsertSteamWishlistReporting, steamWishlistReportingDaily,
  type SteamPrepurchaseDaily, type InsertSteamPrepurchase, steamPrepurchaseDaily,
  type SteamSalesDaily, type InsertSteamSalesDaily, steamSalesDaily,
  type SteamSalesUploadBatch, type InsertSteamSalesUploadBatch, steamSalesUploadBatches,
  type SteamworksSession, type InsertSteamworksSession, steamworksSessions,
  type SteamFollowersDaily, type InsertSteamFollowers, steamFollowersDaily,
  type SteamWishlistRankDaily, type InsertSteamWishlistRank, steamWishlistRankDaily,
  type IgdbHypeDaily, type InsertIgdbHype, igdbHypeDaily,
  type Ps5WishlistDaily, type InsertPs5Wishlist, ps5WishlistDaily,
  type Ps5PrepurchaseDaily, type InsertPs5Prepurchase, ps5PrepurchaseDaily,
  type DynamicForecastDaily, type InsertDynamicForecast, dynamicForecastsDaily,
  type PlsMilestone, type InsertPlsMilestone, plsMilestones,
  type YoutubeLink, type InsertYoutubeLink, plsVideoYoutubeLinks,
  type YoutubeVideoDaily, type InsertYoutubeVideoDaily, youtubeVideoDaily,
  type ForecastRevision, type InsertForecastRevision, forecastRevisions,
  type LaunchForecastSnapshot, type InsertLaunchForecastSnapshot, launchForecastSnapshots,
  type AppSetting, type InsertAppSetting, appSettings,
  type LeaderboardEmailRecipient, type InsertLeaderboardEmailRecipient, leaderboardEmailRecipients,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, desc, isNull, asc, gte, lte } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// ─── Create Tables ───────────────────────────────────────────────────────────

function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      publisher TEXT NOT NULL DEFAULT 'Saber Interactive',
      is_saber_published INTEGER NOT NULL DEFAULT 1,
      platforms TEXT NOT NULL,
      player_format TEXT NOT NULL,
      genre TEXT NOT NULL,
      release_date TEXT NOT NULL,
      target_retail_price_usd REAL,
      per_platform_pricing TEXT,
      steam_app_id TEXT,
      steam_header_image_url TEXT,
      forecast_mode TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_forecasts_comps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      forecast_units INTEGER NOT NULL DEFAULT 0,
      adjusted_pct REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS steam_wishlist_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cumulative_count INTEGER NOT NULL DEFAULT 0,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_wishlist_unique ON steam_wishlist_daily(product_id, date);

    -- Steam Partner Financials API (IPartnerFinancialsService/GetAppWishlistReporting)
    -- daily-delta rows. Additive table; does not replace steam_wishlist_daily above,
    -- which the dashboard still reads via cumulativeCount/dailyDelta.
    CREATE TABLE IF NOT EXISTS steam_wishlist_reporting_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      wishlist_adds INTEGER NOT NULL DEFAULT 0,
      wishlist_deletes INTEGER NOT NULL DEFAULT 0,
      wishlist_purchases INTEGER NOT NULL DEFAULT 0,
      wishlist_gifts INTEGER NOT NULL DEFAULT 0,
      wishlist_adds_windows INTEGER NOT NULL DEFAULT 0,
      wishlist_adds_mac INTEGER NOT NULL DEFAULT 0,
      wishlist_adds_linux INTEGER NOT NULL DEFAULT 0,
      country_summary_json TEXT,
      language_summary_json TEXT,
      fetched_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'api',
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_wishlist_reporting_unique ON steam_wishlist_reporting_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS steam_prepurchase_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cumulative_count INTEGER NOT NULL DEFAULT 0,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_prepurchase_unique ON steam_prepurchase_daily(product_id, date);

    -- v3.0 (2026-08-11): Steam sales daily bucketed by SKU group.
    -- Ingested via CSV upload (Saber-published) or portal fetch (Focus-
    -- published like Space Marine 2). skuGroup ∈ {'base','dlc','other'}.
    CREATE TABLE IF NOT EXISTS steam_sales_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      sku_group TEXT NOT NULL,
      net_units INTEGER NOT NULL DEFAULT 0,
      gross_units INTEGER NOT NULL DEFAULT 0,
      returns INTEGER NOT NULL DEFAULT 0,
      net_revenue_usd REAL NOT NULL DEFAULT 0,
      gross_revenue_usd REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'csv_upload',
      batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_sales_unique ON steam_sales_daily(product_id, date, sku_group);
    CREATE INDEX IF NOT EXISTS steam_sales_batch_idx ON steam_sales_daily(batch_id);

    -- Audit trail for each CSV upload; batch_id FK on steam_sales_daily.
    CREATE TABLE IF NOT EXISTS steam_sales_upload_batches (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      file_bytes INTEGER NOT NULL,
      report_date_start TEXT,
      report_date_end TEXT,
      publisher_name TEXT,
      rows_parsed INTEGER NOT NULL DEFAULT 0,
      rows_ingested INTEGER NOT NULL DEFAULT 0,
      rows_skipped INTEGER NOT NULL DEFAULT 0,
      skipped_reason TEXT,
      uploaded_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS steam_sales_batches_product_idx ON steam_sales_upload_batches(product_id, created_at DESC);

    -- Steamworks session cookies for portal-page fetcher (Focus titles).
    CREATE TABLE IF NOT EXISTS steamworks_sessions (
      id TEXT PRIMARY KEY,
      cookie_value TEXT NOT NULL,
      logged_in_as TEXT,
      last_verified_at TEXT,
      last_verified_result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steam_followers_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      follower_count INTEGER,
      daily_delta INTEGER,
      source TEXT NOT NULL DEFAULT 'public_scrape',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_followers_unique ON steam_followers_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS steam_wishlist_rank_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      rank INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS steam_wishlist_rank_unique ON steam_wishlist_rank_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS igdb_hype_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      igdb_id INTEGER,
      hype_score INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS igdb_hype_unique ON igdb_hype_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS ps5_wishlist_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cumulative_count INTEGER NOT NULL DEFAULT 0,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ps5_wishlist_unique ON ps5_wishlist_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS ps5_prepurchase_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cumulative_count INTEGER NOT NULL DEFAULT 0,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ps5_prepurchase_unique ON ps5_prepurchase_daily(product_id, date);

    CREATE TABLE IF NOT EXISTS dynamic_forecasts_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      platform TEXT NOT NULL,
      forecast_units INTEGER NOT NULL DEFAULT 0,
      steam_wishlist_count_used INTEGER,
      ps5_prepurchase_count_used INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dynamic_forecast_unique ON dynamic_forecasts_daily(product_id, date, platform);

    CREATE TABLE IF NOT EXISTS pls_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      target_date TEXT,
      actual_date TEXT,
      is_default INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS pls_video_youtube_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id INTEGER NOT NULL,
      youtube_video_id TEXT NOT NULL,
      youtube_url TEXT NOT NULL,
      channel_name TEXT,
      video_title TEXT,
      is_official INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (milestone_id) REFERENCES pls_milestones(id)
    );

    CREATE TABLE IF NOT EXISTS youtube_video_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_link_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cumulative_views INTEGER NOT NULL DEFAULT 0,
      daily_delta INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (youtube_link_id) REFERENCES pls_video_youtube_links(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS youtube_daily_unique ON youtube_video_daily(youtube_link_id, date);

    CREATE TABLE IF NOT EXISTS launch_forecast_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      steam_wishlist_count_at_launch INTEGER,
      total_first_month INTEGER NOT NULL,
      total_first_year INTEGER NOT NULL,
      total_lifetime INTEGER NOT NULL,
      steam_first_month INTEGER,
      steam_first_year INTEGER,
      steam_lifetime INTEGER,
      per_platform_forecasts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS launch_forecast_unique_product ON launch_forecast_snapshots(product_id);

    CREATE TABLE IF NOT EXISTS forecast_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      forecast_units INTEGER NOT NULL DEFAULT 0,
      revision_date TEXT NOT NULL,
      revision_label TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leaderboard_email_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_recipients_unique_email ON leaderboard_email_recipients(email);

    -- v3.21 (2026-08-15): Inbound email via Resend webhook. Users reply to
    -- digests and support@ addresses and land here so an admin can view /
    -- reply from the SignalPulse admin UI. Threading uses Resend's
    -- message_id + In-Reply-To/References headers. All inbound goes into
    -- inbound_messages; large attachments live in inbound_attachments
    -- (fetched on demand from Resend's temporary URLs, not stored
    -- inline — keeps DB size bounded).
    CREATE TABLE IF NOT EXISTS inbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resend_email_id TEXT NOT NULL UNIQUE,           -- data.email_id from webhook
      message_id TEXT NOT NULL,                        -- RFC-5322 Message-ID header value; used for threading
      in_reply_to TEXT,                                -- inbound In-Reply-To header, if any
      references_hdr TEXT,                             -- inbound References header, if any
      thread_key TEXT NOT NULL,                        -- normalized threading key: root message_id of the thread
      subject TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL,                         -- e.g. "Steve <sallison@example.com>"
      from_email TEXT NOT NULL,                        -- normalized bare email (lowercased)
      to_addrs TEXT NOT NULL DEFAULT '[]',             -- JSON array
      cc_addrs TEXT NOT NULL DEFAULT '[]',             -- JSON array
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',                -- first ~200 chars of body_text for the inbox list
      raw_json TEXT NOT NULL DEFAULT '{}',             -- full webhook payload for audit / reprocessing
      is_read INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      direction TEXT NOT NULL DEFAULT 'inbound',       -- inbound | outbound; outbound rows are replies we sent
      outbound_status TEXT,                            -- null for inbound; sent | failed for outbound
      outbound_error TEXT,                             -- populated when outbound_status = failed
      received_at TEXT NOT NULL,                       -- inbound: from webhook data.created_at; outbound: send time
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbound_messages_thread_idx ON inbound_messages(thread_key, received_at);
    CREATE INDEX IF NOT EXISTS inbound_messages_received_idx ON inbound_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS inbound_messages_unread_idx ON inbound_messages(is_read, is_archived, received_at DESC);

    CREATE TABLE IF NOT EXISTS inbound_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,                     -- FK to inbound_messages.id
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER,
      -- Resend returns temporary download URLs; we store the URL and let the
      -- UI fetch on demand. If the URL expires, we can re-fetch via the
      -- receiving API using the parent resend_email_id.
      download_url TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES inbound_messages(id)
    );
    CREATE INDEX IF NOT EXISTS inbound_attachments_message_idx ON inbound_attachments(message_id);
  `);
}

// v3.14 (2026-08-12): `CREATE TABLE IF NOT EXISTS` above only creates the
// column on a fresh DB — an existing products table (prod already has
// rows) needs an explicit ALTER TABLE to pick up new columns. SQLite has
// no `ADD COLUMN IF NOT EXISTS`, so check pragma_table_info first.
function migrateAddColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function runMigrations() {
  migrateAddColumnIfMissing("products", "steam_header_image_url", "steam_header_image_url TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "alert_sent_at", "alert_sent_at TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "refresh_source", "refresh_source TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "auto_refresh_last_attempt_at", "auto_refresh_last_attempt_at TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "auto_refresh_last_result", "auto_refresh_last_result TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "refresh_requested_at", "refresh_requested_at TEXT");
  migrateAddColumnIfMissing("steamworks_sessions", "refresh_token_value", "refresh_token_value TEXT");
}

initializeDatabase();
runMigrations();

/**
 * Combined summary of wishlist state for a product (v2.1, 2026-08-11).
 * Computed from steam_wishlist_reporting_daily rows on demand. All counts
 * are NET (adds - deletes - purchases). Purchases represent wishlist -> buy
 * conversions, which permanently remove the wishlist entry, so they
 * subtract from the running total the same way deletes do.
 *
 * When releaseDate is null (product not yet released), preLaunchNet ==
 * lifetimeNet and postLaunchNet == 0. When releaseDate is set,
 * preLaunchNet is a LOCKED number that never changes with future data;
 * postLaunchNet grows daily.
 *
 * dayOverDayDelta is the most recent day's net change; when there's a
 * data gap the comparison date isn't literally yesterday, and isStale
 * flags that so the UI can warn users.
 */
export interface SteamWishlistSummary {
  preLaunchNet: number | null;
  postLaunchNet: number | null;
  lifetimeNet: number | null;
  dayOverDayDelta: number | null;
  latestDate: string | null;
  dayOverDayComparisonDate: string | null;
  isStale: boolean;
  rowCount: number;
}

/**
 * Rolled-up sales summary for a product. Splits base-game SKUs from DLCs
 * per the user-locked rule 2026-08-11: 'main SKUs cumulative, DLCs not'.
 * All numbers are lifetime totals across ingested rows.
 */
export interface SteamSalesSummary {
  baseNetUnits: number;
  baseGrossUnits: number;
  baseReturns: number;
  baseNetRevenueUsd: number;
  dlcNetUnits: number;
  dlcNetRevenueUsd: number;
  otherNetUnits: number;
  otherNetRevenueUsd: number;
  firstDate: string | null;
  latestDate: string | null;
  rowCount: number;
  sourceMix: Record<string, number>; // e.g. { csv_upload: 42, portal_fetch: 7 }
}

/**
 * Steam sales revenue split by release date — used on the dashboard
 * product card to show Pre-Release / Post-Release / Total 'Steam Revenue'.
 * When product release date is null (unshipped titles that never had a
 * release recorded), everything falls under postRelease as a conservative
 * default. When a row's date < releaseDate it counts as pre-release
 * (pre-order fulfillment revenue), otherwise post-release.
 *
 * Revenue values sum base + dlc; retail activations are excluded at parse
 * time already so they don't enter these totals.
 */
export interface SteamRevenueByReleaseSplit {
  preReleaseRevenueUsd: number;   // sum of base + dlc net revenue, rows dated < releaseDate
  postReleaseRevenueUsd: number;  // sum of base + dlc net revenue, rows dated >= releaseDate (or all rows if releaseDate is null)
  totalRevenueUsd: number;

  // v3.4 (2026-08-11): units alongside revenue so we can compute ASP.
  // 'base' only — DLC ASP is a different narrative (much lower per-unit,
  // priced differently) so we keep those separate. If you later want DLC ASP
  // we can add another triple.
  preReleaseBaseNetUnits: number;
  postReleaseBaseNetUnits: number;
  totalBaseNetUnits: number;

  // Convenience — base ASP = base revenue / base units (only when units > 0).
  preReleaseBaseAspUsd: number | null;
  postReleaseBaseAspUsd: number | null;
  totalBaseAspUsd: number | null;

  preReleaseRowCount: number;
  postReleaseRowCount: number;
  releaseDate: string | null;     // echoed for downstream reference
  firstDate: string | null;
  latestDate: string | null;
}

// ─── Storage Interface ───────────────────────────────────────────────────────

export interface IStorage {
  // Products
  getAllProducts(): Product[];
  getProduct(id: number): Product | undefined;
  createProduct(product: InsertProduct): Product;
  updateProduct(id: number, data: Partial<InsertProduct>): Product | undefined;
  /** Cache-only write — does not bump updatedAt, since this is background ingestion, not a user edit. */
  updateProductHeaderImage(id: number, url: string | null): void;
  deleteProduct(id: number): void;

  // Steam Wishlists
  getSteamWishlists(productId: number): SteamWishlistDaily[];
  getLatestSteamWishlist(productId: number): SteamWishlistDaily | undefined;
  addSteamWishlist(data: InsertSteamWishlist): SteamWishlistDaily;

  // Steam Wishlist Reporting (IPartnerFinancialsService daily deltas)
  getSteamWishlistReporting(productId: number, from?: string, to?: string): SteamWishlistReportingDaily[];
  getSteamWishlistReportingByDate(productId: number, date: string): SteamWishlistReportingDaily | undefined;
  getLatestSteamWishlistReporting(productId: number): SteamWishlistReportingDaily | undefined;
  getEarliestSteamWishlistReporting(productId: number): SteamWishlistReportingDaily | undefined;
  upsertSteamWishlistReporting(data: InsertSteamWishlistReporting): SteamWishlistReportingDaily;

  // v2.1 (2026-08-11): Aggregate summary that computes pre-launch,
  // post-launch, and lifetime net wishlist counts plus day-over-day
  // delta for the most recent row. Reads from steam_wishlist_reporting_daily
  // (true daily deltas from Partner API), not the legacy cumulative table.
  // Net = wishlist_adds - wishlist_deletes - wishlist_purchases.
  // Returns null-filled struct if the product has no reporting rows yet.
  getSteamWishlistSummary(productId: number, releaseDate: string | null): SteamWishlistSummary;

  // v3.18 (2026-08-13): Gross "wishlist adds" (not net) totalled over the
  // trailing 7-day window ending on the latest available reporting date for
  // that product (mirrors the anchor-on-latest-row pattern used by
  // getSteamWishlistRankDaysAgo, so a lagging ingest day doesn't shift the
  // window to a date with no data at all). Returns null when the product has
  // no reporting rows yet.
  getSteamWishlistAdds7dTotal(productId: number): number | null;

  // Steam Prepurchases
  getSteamPrepurchases(productId: number): SteamPrepurchaseDaily[];
  getLatestSteamPrepurchase(productId: number): SteamPrepurchaseDaily | undefined;
  addSteamPrepurchase(data: InsertSteamPrepurchase): SteamPrepurchaseDaily;

  // Steam Sales (v3.0 — CSV upload + portal fetch ingest)
  getSteamSales(productId: number, opts?: { since?: string; until?: string }): SteamSalesDaily[];
  getSteamSalesSummary(productId: number): SteamSalesSummary;
  getSteamRevenueByReleaseSplit(productId: number, releaseDate: string | null): SteamRevenueByReleaseSplit;
  /**
   * v3.7 (2026-08-12): Steam actual first-N-days base net units post-release.
   * Returns null when the title is unreleased or has < windowDays coverage
   * post-release (so we don't feed a partial signal into the dynamic forecast).
   */
  getSteamActualFirstMonthBaseUnits(
    productId: number,
    releaseDate: string | null,
    windowDays?: number,
  ): number | null;
  /**
   * v3.8 (2026-08-12): Steam cumulative BASE net units to-date (post-release only).
   * Returns null when unreleased. Sums base skuGroup net units on
   * every date >= releaseDate. Used to feed Steam LT projection.
   */
  getSteamActualCumulativeBaseUnits(
    productId: number,
    releaseDate: string | null,
  ): number | null;
  upsertSteamSalesRows(rows: InsertSteamSalesDaily[]): { inserted: number; updated: number };
  deleteSteamSalesByBatch(batchId: string): number;

  // Steam Sales upload batches (audit trail for CSV uploads)
  createSteamSalesUploadBatch(data: InsertSteamSalesUploadBatch): SteamSalesUploadBatch;
  getSteamSalesUploadBatches(productId: number): SteamSalesUploadBatch[];
  getSteamSalesUploadBatch(id: string): SteamSalesUploadBatch | undefined;

  // Steamworks session cookies (for Focus portal fetcher)
  getSteamworksSession(id: string): SteamworksSession | undefined;
  upsertSteamworksSession(data: InsertSteamworksSession): SteamworksSession;
  deleteSteamworksSession(id: string): boolean;
  requestSteamworksSessionRefresh(id: string): SteamworksSession | undefined;
  logSteamworksSessionRefreshAttempt(id: string, attemptedAt: string, result: string): void;
  // Proactive cookie-expiry alerting: tracks when we last sent an expiry
  // email for the CURRENT failure episode, separate from upsertSteamworksSession
  // so unrelated callers (cookie save, verify-ok) can't accidentally clobber it.
  setSteamworksSessionAlertSent(id: string, alertSentAt: string | null): void;

  // Steam Followers (Steam Leaderboards — Wishlist board, public-scrape only)
  getSteamFollowers(productId: number): SteamFollowersDaily[];
  getLatestSteamFollowers(productId: number): SteamFollowersDaily | undefined;
  upsertSteamFollowers(data: InsertSteamFollowers): SteamFollowersDaily;

  // Steam Wishlist Rank (Steam Leaderboards — Wishlist board, top-200 public listing)
  getSteamWishlistRanks(productId: number): SteamWishlistRankDaily[];
  getLatestSteamWishlistRank(productId: number): SteamWishlistRankDaily | undefined;
  /** Returns the row exactly `daysAgo` calendar days before the latest row's date, or undefined if none. */
  getSteamWishlistRankDaysAgo(productId: number, daysAgo: number): SteamWishlistRankDaily | undefined;
  upsertSteamWishlistRank(data: InsertSteamWishlistRank): SteamWishlistRankDaily;

  // IGDB Hype (Steam Leaderboards — Wishlist board)
  getIgdbHypeHistory(productId: number): IgdbHypeDaily[];
  getLatestIgdbHype(productId: number): IgdbHypeDaily | undefined;
  upsertIgdbHype(data: InsertIgdbHype): IgdbHypeDaily;

  // PS5 Wishlists
  getPs5Wishlists(productId: number): Ps5WishlistDaily[];
  getLatestPs5Wishlist(productId: number): Ps5WishlistDaily | undefined;
  addPs5Wishlist(data: InsertPs5Wishlist): Ps5WishlistDaily;

  // PS5 Prepurchases
  getPs5Prepurchases(productId: number): Ps5PrepurchaseDaily[];
  getLatestPs5Prepurchase(productId: number): Ps5PrepurchaseDaily | undefined;
  addPs5Prepurchase(data: InsertPs5Prepurchase): Ps5PrepurchaseDaily;

  // Dynamic Forecasts
  getDynamicForecasts(productId: number): DynamicForecastDaily[];
  getLatestDynamicForecasts(productId: number): DynamicForecastDaily[];
  upsertDynamicForecasts(forecasts: InsertDynamicForecast[]): void;

  // PLS Milestones
  getPlsMilestones(productId: number): PlsMilestone[];
  createPlsMilestone(data: InsertPlsMilestone): PlsMilestone;
  updatePlsMilestone(id: number, data: Partial<InsertPlsMilestone>): PlsMilestone | undefined;
  deletePlsMilestone(id: number): void;

  // YouTube Links
  getYoutubeLinks(milestoneId: number): YoutubeLink[];
  addYoutubeLink(data: InsertYoutubeLink): YoutubeLink;
  deleteYoutubeLink(id: number): void;

  // YouTube Daily
  getYoutubeViews(linkId: number): YoutubeVideoDaily[];
  addYoutubeVideoDaily(data: { youtubeLinkId: number; date: string; cumulativeViews: number; dailyDelta: number }): YoutubeVideoDaily;
  getAllYoutubeLinks(): YoutubeLink[];
  getAggregateYoutubeViews(milestoneId: number): {
    totalViews: number;
    officialViews: number;
    reuploadViews: number;
    videos: Array<{
      link: YoutubeLink;
      latestViews: number;
      dailyData: YoutubeVideoDaily[];
    }>;
    aggregateTimeSeries: Array<{ date: string; cumulativeViews: number; dailyDelta: number }>;
  };

  // ─── Launch Forecast Snapshot (v3.22) ────────────────────────────────────
  // Idempotent write — does nothing if a snapshot already exists for productId.
  // Returns the row that now exists (either freshly-created or pre-existing).
  upsertLaunchForecastSnapshotIfMissing(data: InsertLaunchForecastSnapshot): LaunchForecastSnapshot;
  getLaunchForecastSnapshot(productId: number): LaunchForecastSnapshot | null;

  // App Settings
  getAllSettings(): AppSetting[];
  getSetting(key: string): AppSetting | undefined;
  upsertSetting(key: string, value: string): AppSetting;
  seedDefaultSettings(): void;

  // Leaderboard Weekly Email Recipients
  getLeaderboardEmailRecipients(): LeaderboardEmailRecipient[];
  getActiveLeaderboardEmailRecipients(): LeaderboardEmailRecipient[];
  createLeaderboardEmailRecipient(data: InsertLeaderboardEmailRecipient): LeaderboardEmailRecipient;
  updateLeaderboardEmailRecipient(id: number, data: Partial<InsertLeaderboardEmailRecipient>): LeaderboardEmailRecipient | undefined;
  deleteLeaderboardEmailRecipient(id: number): void;

  // Inbound email (v3.21, 2026-08-15)
  insertInboundMessage(data: InsertInboundMessage): InboundMessage;
  getInboundMessage(id: number): InboundMessage | undefined;
  getInboundByResendEmailId(resendEmailId: string): InboundMessage | undefined;
  getInboundByMessageId(messageId: string): InboundMessage | undefined;
  listInboundMessages(opts: { includeArchived?: boolean; limit?: number; offset?: number }): InboundMessage[];
  listInboundThread(threadKey: string): InboundMessage[];
  countUnreadInbound(): number;
  markInboundRead(id: number, read: boolean): void;
  archiveInbound(id: number, archived: boolean): void;
  insertInboundAttachment(data: InsertInboundAttachment): InboundAttachment;
  listInboundAttachments(messageId: number): InboundAttachment[];
}

// ─── Inbound email types (v3.21, 2026-08-15) ─────────────────────────────
export interface InboundMessage {
  id: number;
  resend_email_id: string;
  message_id: string;
  in_reply_to: string | null;
  references_hdr: string | null;
  thread_key: string;
  subject: string;
  from_addr: string;
  from_email: string;
  to_addrs: string;   // JSON array
  cc_addrs: string;   // JSON array
  body_text: string;
  body_html: string;
  snippet: string;
  raw_json: string;
  is_read: number;
  is_archived: number;
  direction: string;  // "inbound" | "outbound"
  outbound_status: string | null;
  outbound_error: string | null;
  received_at: string;
  created_at: string;
}
export type InsertInboundMessage = Omit<InboundMessage, "id">;

export interface InboundAttachment {
  id: number;
  message_id: number;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  download_url: string | null;
  created_at: string;
}
export type InsertInboundAttachment = Omit<InboundAttachment, "id">;

// Convenience alias used by inbound-email.ts
export type Storage = IStorage;

export class DatabaseStorage implements IStorage {
  private now(): string {
    return new Date().toISOString();
  }

  // ─── Products ────────────────────────────────────────────────────────────────

  getAllProducts(): Product[] {
    return db.select().from(products).all();
  }

  getProduct(id: number): Product | undefined {
    return db.select().from(products).where(eq(products.id, id)).get();
  }

  createProduct(data: InsertProduct): Product {
    const now = this.now();
    return db.insert(products).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
  }

  updateProduct(id: number, data: Partial<InsertProduct>): Product | undefined {
    const now = this.now();
    return db.update(products)
      .set({ ...data, updatedAt: now })
      .where(eq(products.id, id))
      .returning().get();
  }

  updateProductHeaderImage(id: number, url: string | null): void {
    db.update(products)
      .set({ steamHeaderImageUrl: url })
      .where(eq(products.id, id))
      .run();
  }

  deleteProduct(id: number): void {
    // Delete all related data first (foreign key constraints)
    // 1. YouTube daily views (linked through milestones → youtube links)
    const milestones = this.getPlsMilestones(id);
    for (const m of milestones) {
      const links = this.getYoutubeLinks(m.id);
      for (const link of links) {
        db.delete(youtubeVideoDaily).where(eq(youtubeVideoDaily.youtubeLinkId, link.id)).run();
      }
      db.delete(plsVideoYoutubeLinks).where(eq(plsVideoYoutubeLinks.milestoneId, m.id)).run();
    }
    // 2. PLS milestones (including soft-deleted)
    db.delete(plsMilestones).where(eq(plsMilestones.productId, id)).run();
    // 3. Forecast data
    db.delete(productForecastsComps).where(eq(productForecastsComps.productId, id)).run();
    db.delete(forecastRevisions).where(eq(forecastRevisions.productId, id)).run();
    db.delete(dynamicForecastsDaily).where(eq(dynamicForecastsDaily.productId, id)).run();
    // 4. Daily tracking data
    db.delete(steamWishlistDaily).where(eq(steamWishlistDaily.productId, id)).run();
    db.delete(steamWishlistReportingDaily).where(eq(steamWishlistReportingDaily.productId, id)).run();
    db.delete(steamPrepurchaseDaily).where(eq(steamPrepurchaseDaily.productId, id)).run();
    db.delete(ps5WishlistDaily).where(eq(ps5WishlistDaily.productId, id)).run();
    db.delete(ps5PrepurchaseDaily).where(eq(ps5PrepurchaseDaily.productId, id)).run();
    // 5. Finally delete the product
    db.delete(products).where(eq(products.id, id)).run();
  }

  // ─── Steam Wishlists ─────────────────────────────────────────────────────────

  getSteamWishlists(productId: number): SteamWishlistDaily[] {
    return db.select().from(steamWishlistDaily)
      .where(eq(steamWishlistDaily.productId, productId))
      .orderBy(asc(steamWishlistDaily.date)).all();
  }

  getLatestSteamWishlist(productId: number): SteamWishlistDaily | undefined {
    return db.select().from(steamWishlistDaily)
      .where(eq(steamWishlistDaily.productId, productId))
      .orderBy(desc(steamWishlistDaily.date))
      .limit(1).get();
  }

  addSteamWishlist(data: InsertSteamWishlist): SteamWishlistDaily {
    const now = this.now();
    try {
      return db.insert(steamWishlistDaily).values({
        ...data,
        createdAt: now,
      }).returning().get();
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Update existing record instead
        return db.update(steamWishlistDaily)
          .set({ cumulativeCount: data.cumulativeCount, dailyDelta: data.dailyDelta, source: data.source })
          .where(and(eq(steamWishlistDaily.productId, data.productId), eq(steamWishlistDaily.date, data.date)))
          .returning().get();
      }
      throw err;
    }
  }

  // ─── Steam Wishlist Reporting (IPartnerFinancialsService) ──────────────────

  getSteamWishlistReporting(productId: number, from?: string, to?: string): SteamWishlistReportingDaily[] {
    const conditions = [eq(steamWishlistReportingDaily.productId, productId)];
    if (from) conditions.push(gte(steamWishlistReportingDaily.date, from));
    if (to) conditions.push(lte(steamWishlistReportingDaily.date, to));
    return db.select().from(steamWishlistReportingDaily)
      .where(and(...conditions))
      .orderBy(asc(steamWishlistReportingDaily.date)).all();
  }

  getSteamWishlistReportingByDate(productId: number, date: string): SteamWishlistReportingDaily | undefined {
    return db.select().from(steamWishlistReportingDaily)
      .where(and(
        eq(steamWishlistReportingDaily.productId, productId),
        eq(steamWishlistReportingDaily.date, date),
      )).get();
  }

  getLatestSteamWishlistReporting(productId: number): SteamWishlistReportingDaily | undefined {
    return db.select().from(steamWishlistReportingDaily)
      .where(eq(steamWishlistReportingDaily.productId, productId))
      .orderBy(desc(steamWishlistReportingDaily.date))
      .limit(1).get();
  }

  getEarliestSteamWishlistReporting(productId: number): SteamWishlistReportingDaily | undefined {
    return db.select().from(steamWishlistReportingDaily)
      .where(eq(steamWishlistReportingDaily.productId, productId))
      .orderBy(asc(steamWishlistReportingDaily.date))
      .limit(1).get();
  }

  upsertSteamWishlistReporting(data: InsertSteamWishlistReporting): SteamWishlistReportingDaily {
    const existing = this.getSteamWishlistReportingByDate(data.productId, data.date);
    if (existing) {
      return db.update(steamWishlistReportingDaily)
        .set({
          wishlistAdds: data.wishlistAdds,
          wishlistDeletes: data.wishlistDeletes,
          wishlistPurchases: data.wishlistPurchases,
          wishlistGifts: data.wishlistGifts,
          wishlistAddsWindows: data.wishlistAddsWindows,
          wishlistAddsMac: data.wishlistAddsMac,
          wishlistAddsLinux: data.wishlistAddsLinux,
          countrySummaryJson: data.countrySummaryJson,
          languageSummaryJson: data.languageSummaryJson,
          fetchedAt: data.fetchedAt,
          source: data.source,
        })
        .where(eq(steamWishlistReportingDaily.id, existing.id))
        .returning().get();
    }
    return db.insert(steamWishlistReportingDaily).values(data).returning().get();
  }

  /**
   * Aggregate summary of wishlist activity: pre-launch net, post-launch net,
   * lifetime net, and day-over-day delta computed from the daily-delta table.
   *
   * Design choices:
   *  - Uses one query to pull all rows then splits in JS. For SM2's ~815 rows
   *    that's <2KB and negligible CPU. Splitting in SQL would need two
   *    conditional-sum queries; not worth the complexity.
   *  - dayOverDayDelta is computed from the single most-recent row's own
   *    (adds - deletes - purchases). It is NOT (latestRow.net -
   *    secondLatestRow.net) because rows already store the daily delta
   *    directly. Using row-vs-row would double-count when rows have gaps
   *    between them.
   *  - isStale is true when the latest row is more than 2 days behind
   *    'today' (GMT). Wishlist reporting is bounded to yesterday-GMT, so a
   *    2-day slack is normal; anything larger signals ingestion has fallen
   *    behind.
   */
  getSteamWishlistSummary(productId: number, releaseDate: string | null): SteamWishlistSummary {
    const rows = this.getSteamWishlistReporting(productId);
    if (rows.length === 0) {
      return {
        preLaunchNet: null,
        postLaunchNet: null,
        lifetimeNet: null,
        dayOverDayDelta: null,
        latestDate: null,
        dayOverDayComparisonDate: null,
        isStale: false,
        rowCount: 0,
      };
    }

    // Rows are already ordered by date ASC per getSteamWishlistReporting.
    let preLaunchNet = 0;
    let postLaunchNet = 0;
    for (const r of rows) {
      const delta = r.wishlistAdds - r.wishlistDeletes - r.wishlistPurchases;
      // Compare using string comparison — dates are all YYYY-MM-DD, which
      // is lexicographically sortable and matches actual date order.
      if (releaseDate != null && r.date < releaseDate) {
        preLaunchNet += delta;
      } else {
        postLaunchNet += delta;
      }
    }

    // If releaseDate is null (unreleased product), everything is pre-launch.
    // Wire that: postLaunchNet is 0 (by construction above; the else branch
    // is skipped because releaseDate is null and the condition short-circuits
    // to always take the else). Fix: when releaseDate is null the loop above
    // classifies everything as post-launch (else branch); we want the opposite.
    // Re-partition here rather than complicating the loop.
    if (releaseDate == null) {
      preLaunchNet = postLaunchNet;
      postLaunchNet = 0;
    }

    const lifetimeNet = preLaunchNet + postLaunchNet;

    // Day-over-day delta = the most recent row's own daily net.
    const latest = rows[rows.length - 1];
    const dayOverDayDelta =
      latest.wishlistAdds - latest.wishlistDeletes - latest.wishlistPurchases;
    const dayOverDayComparisonDate =
      rows.length >= 2 ? rows[rows.length - 2].date : null;

    // Staleness: today-GMT minus latest.date > 2 days => stale.
    // Uses UTC math to match Steam's GMT bounding.
    const todayUtcMs = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const [ly, lm, ld] = latest.date.split("-").map(Number);
    const latestUtcMs = Date.UTC(ly, lm - 1, ld);
    const daysBehind = (todayUtcMs - latestUtcMs) / 86400000;
    const isStale = daysBehind > 2;

    return {
      preLaunchNet,
      postLaunchNet,
      lifetimeNet,
      dayOverDayDelta,
      latestDate: latest.date,
      dayOverDayComparisonDate,
      isStale,
      rowCount: rows.length,
    };
  }

  /**
   * Sum of gross `wishlistAdds` (not net — deletes/purchases excluded) over
   * the trailing 7-day window ending on the latest available reporting date
   * for this product. Anchored on the latest row's own date rather than
   * literal "today" so a day or two of ingestion lag doesn't just return 0 —
   * same pattern as getSteamWishlistRankDaysAgo. Returns null when the
   * product has no reporting rows at all.
   */
  getSteamWishlistAdds7dTotal(productId: number): number | null {
    const rows = this.getSteamWishlistReporting(productId); // ascending by date
    if (rows.length === 0) return null;
    const latestDate = rows[rows.length - 1].date;
    const windowStart = new Date(`${latestDate}T00:00:00Z`);
    windowStart.setUTCDate(windowStart.getUTCDate() - 6); // 7-day window inclusive of latestDate
    const windowStartStr = windowStart.toISOString().split("T")[0];
    let total = 0;
    for (const r of rows) {
      if (r.date >= windowStartStr && r.date <= latestDate) {
        total += r.wishlistAdds;
      }
    }
    return total;
  }

  // ─── Steam Prepurchases ──────────────────────────────────────────────────────

  getSteamPrepurchases(productId: number): SteamPrepurchaseDaily[] {
    return db.select().from(steamPrepurchaseDaily)
      .where(eq(steamPrepurchaseDaily.productId, productId))
      .orderBy(asc(steamPrepurchaseDaily.date)).all();
  }

  getLatestSteamPrepurchase(productId: number): SteamPrepurchaseDaily | undefined {
    return db.select().from(steamPrepurchaseDaily)
      .where(eq(steamPrepurchaseDaily.productId, productId))
      .orderBy(desc(steamPrepurchaseDaily.date))
      .limit(1).get();
  }

  addSteamPrepurchase(data: InsertSteamPrepurchase): SteamPrepurchaseDaily {
    const now = this.now();
    try {
      return db.insert(steamPrepurchaseDaily).values({
        ...data,
        createdAt: now,
      }).returning().get();
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return db.update(steamPrepurchaseDaily)
          .set({ cumulativeCount: data.cumulativeCount, dailyDelta: data.dailyDelta, source: data.source })
          .where(and(eq(steamPrepurchaseDaily.productId, data.productId), eq(steamPrepurchaseDaily.date, data.date)))
          .returning().get();
      }
      throw err;
    }
  }

  // ─── Steam Sales (v3.0) ──────────────────────────────────────────────

  getSteamSales(
    productId: number,
    opts?: { since?: string; until?: string },
  ): SteamSalesDaily[] {
    const conds = [eq(steamSalesDaily.productId, productId)];
    if (opts?.since) conds.push(gte(steamSalesDaily.date, opts.since));
    if (opts?.until) conds.push(lte(steamSalesDaily.date, opts.until));
    return db.select().from(steamSalesDaily)
      .where(and(...conds))
      .orderBy(asc(steamSalesDaily.date), asc(steamSalesDaily.skuGroup)).all();
  }

  /**
   * Aggregate lifetime totals split by SKU group. Cheap: one SELECT with
   * GROUP BY. All-time totals — date filters would go on
   * getSteamSales() and the caller sums manually.
   */
  getSteamSalesSummary(productId: number): SteamSalesSummary {
    const rows = db.select().from(steamSalesDaily)
      .where(eq(steamSalesDaily.productId, productId)).all();

    const summary: SteamSalesSummary = {
      baseNetUnits: 0,
      baseGrossUnits: 0,
      baseReturns: 0,
      baseNetRevenueUsd: 0,
      dlcNetUnits: 0,
      dlcNetRevenueUsd: 0,
      otherNetUnits: 0,
      otherNetRevenueUsd: 0,
      firstDate: null,
      latestDate: null,
      rowCount: rows.length,
      sourceMix: {},
    };

    for (const r of rows) {
      if (r.skuGroup === "base") {
        summary.baseNetUnits += r.netUnits;
        summary.baseGrossUnits += r.grossUnits;
        summary.baseReturns += r.returns;
        summary.baseNetRevenueUsd += r.netRevenueUsd;
      } else if (r.skuGroup === "dlc") {
        summary.dlcNetUnits += r.netUnits;
        summary.dlcNetRevenueUsd += r.netRevenueUsd;
      } else {
        summary.otherNetUnits += r.netUnits;
        summary.otherNetRevenueUsd += r.netRevenueUsd;
      }
      summary.sourceMix[r.source] = (summary.sourceMix[r.source] ?? 0) + 1;
      if (!summary.firstDate || r.date < summary.firstDate) summary.firstDate = r.date;
      if (!summary.latestDate || r.date > summary.latestDate) summary.latestDate = r.date;
    }
    // Round revenue to cents
    summary.baseNetRevenueUsd = Math.round(summary.baseNetRevenueUsd * 100) / 100;
    summary.dlcNetRevenueUsd = Math.round(summary.dlcNetRevenueUsd * 100) / 100;
    summary.otherNetRevenueUsd = Math.round(summary.otherNetRevenueUsd * 100) / 100;
    return summary;
  }

  /**
   * Steam revenue split by release date. Uses SUM aggregation server-side
   * to keep the dashboard-list enrichment cheap (one query per product).
   * Rows dated strictly before releaseDate count as pre-release (pre-order
   * fulfillment); rows dated on or after releaseDate count as post-release.
   * If releaseDate is null, everything counts as post-release.
   */
  getSteamRevenueByReleaseSplit(productId: number, releaseDate: string | null): SteamRevenueByReleaseSplit {
    const rows = db.select().from(steamSalesDaily)
      .where(eq(steamSalesDaily.productId, productId)).all();

    const result: SteamRevenueByReleaseSplit = {
      preReleaseRevenueUsd: 0,
      postReleaseRevenueUsd: 0,
      totalRevenueUsd: 0,
      preReleaseBaseNetUnits: 0,
      postReleaseBaseNetUnits: 0,
      totalBaseNetUnits: 0,
      preReleaseBaseAspUsd: null,
      postReleaseBaseAspUsd: null,
      totalBaseAspUsd: null,
      preReleaseRowCount: 0,
      postReleaseRowCount: 0,
      releaseDate,
      firstDate: null,
      latestDate: null,
    };

    // v3.4 (2026-08-11): base-only units are needed for ASP; base+dlc revenue
    // still flows into the total. We track a base-revenue running total
    // separately so ASP = baseRev / baseUnits is precise (mixing dlc in would
    // make ASP artificially high due to DLC's lower price point).
    let preReleaseBaseRevUsd = 0;
    let postReleaseBaseRevUsd = 0;

    for (const r of rows) {
      // Only count base + dlc; 'other' (soundtrack, artbook) is excluded
      // from revenue tracking on the dashboard.
      if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue;

      const rev = r.netRevenueUsd;
      if (releaseDate && r.date < releaseDate) {
        result.preReleaseRevenueUsd += rev;
        result.preReleaseRowCount++;
        if (r.skuGroup === "base") {
          result.preReleaseBaseNetUnits += r.netUnits;
          preReleaseBaseRevUsd += rev;
        }
      } else {
        result.postReleaseRevenueUsd += rev;
        result.postReleaseRowCount++;
        if (r.skuGroup === "base") {
          result.postReleaseBaseNetUnits += r.netUnits;
          postReleaseBaseRevUsd += rev;
        }
      }
      if (!result.firstDate || r.date < result.firstDate) result.firstDate = r.date;
      if (!result.latestDate || r.date > result.latestDate) result.latestDate = r.date;
    }

    result.preReleaseRevenueUsd = Math.round(result.preReleaseRevenueUsd * 100) / 100;
    result.postReleaseRevenueUsd = Math.round(result.postReleaseRevenueUsd * 100) / 100;
    result.totalRevenueUsd = Math.round((result.preReleaseRevenueUsd + result.postReleaseRevenueUsd) * 100) / 100;
    result.totalBaseNetUnits = result.preReleaseBaseNetUnits + result.postReleaseBaseNetUnits;

    result.preReleaseBaseAspUsd = result.preReleaseBaseNetUnits > 0
      ? Math.round((preReleaseBaseRevUsd / result.preReleaseBaseNetUnits) * 100) / 100
      : null;
    result.postReleaseBaseAspUsd = result.postReleaseBaseNetUnits > 0
      ? Math.round((postReleaseBaseRevUsd / result.postReleaseBaseNetUnits) * 100) / 100
      : null;
    const totalBaseRev = preReleaseBaseRevUsd + postReleaseBaseRevUsd;
    result.totalBaseAspUsd = result.totalBaseNetUnits > 0
      ? Math.round((totalBaseRev / result.totalBaseNetUnits) * 100) / 100
      : null;

    return result;
  }

  /**
   * v3.7 (2026-08-12): Steam actual first-N-days base net units.
   *
   * Rules:
   *   - Returns null if the product has no releaseDate.
   *   - Returns null if today < releaseDate + windowDays (partial window).
   *   - Otherwise sums base skuGroup net units on dates in
   *     [releaseDate, releaseDate + windowDays).
   *
   * Default windowDays = 30 (first month).
   */
  getSteamActualFirstMonthBaseUnits(
    productId: number,
    releaseDate: string | null,
    windowDays: number = 30,
  ): number | null {
    if (!releaseDate) return null;

    // Compute release + windowDays as YYYY-MM-DD.
    const relEpochMs = Date.parse(releaseDate + "T00:00:00Z");
    if (Number.isNaN(relEpochMs)) return null;
    const windowEndMs = relEpochMs + windowDays * 86400_000;
    const windowEndDate = new Date(windowEndMs).toISOString().split("T")[0];

    // Reject if today hasn't reached the end of the window yet.
    const todayDate = new Date().toISOString().split("T")[0];
    if (todayDate < windowEndDate) return null;

    // Sum base netUnits in [releaseDate, windowEndDate)
    const rows = db.select().from(steamSalesDaily)
      .where(and(
        eq(steamSalesDaily.productId, productId),
        gte(steamSalesDaily.date, releaseDate),
        lte(steamSalesDaily.date, windowEndDate), // inclusive of last day
        eq(steamSalesDaily.skuGroup, "base"),
      ))
      .all();

    if (rows.length === 0) return null;

    // Only count rows strictly before the windowEnd calendar day
    let total = 0;
    for (const r of rows) {
      if (r.date < windowEndDate) total += r.netUnits;
    }
    return total > 0 ? total : null;
  }

  /**
   * v3.8 (2026-08-12): Steam cumulative BASE net units to-date, INCLUSIVE
   * of pre-release pre-purchase units + post-release sales. Returns the
   * same number that appears in the Steam Sales card 'Steam Base Game
   * Units' tile (totalBaseNetUnits). Returns null pre-release only when
   * there's no data at all.
   *
   * Fix (v3.8.1, 2026-08-12): earlier drafts filtered to date >= releaseDate
   * which excluded pre-order units. Pre-order units are real sales and
   * belong in the LT projection.
   */
  getSteamActualCumulativeBaseUnits(
    productId: number,
    _releaseDate: string | null,
  ): number | null {
    // Sum all base skuGroup rows for the product regardless of release date.
    // (releaseDate arg kept for API symmetry with getSteamActualFirstMonthBaseUnits.)
    const rows = db.select().from(steamSalesDaily)
      .where(and(
        eq(steamSalesDaily.productId, productId),
        eq(steamSalesDaily.skuGroup, "base"),
      ))
      .all();
    if (rows.length === 0) return null;
    let total = 0;
    for (const r of rows) total += r.netUnits;
    return total > 0 ? total : null;
  }

  /**
   * Bulk upsert. Uses transaction + insert-or-update on the
   * (product_id, date, sku_group) unique index. Returns count breakdown so
   * the caller can surface it to the user.
   */
  upsertSteamSalesRows(rows: InsertSteamSalesDaily[]): { inserted: number; updated: number } {
    const now = this.now();
    let inserted = 0;
    let updated = 0;
    const runOne = (r: InsertSteamSalesDaily) => {
      try {
        db.insert(steamSalesDaily).values({
          ...r,
          createdAt: now,
          updatedAt: now,
        }).run();
        inserted++;
      } catch (err: any) {
        if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
          db.update(steamSalesDaily)
            .set({
              netUnits: r.netUnits,
              grossUnits: r.grossUnits,
              returns: r.returns,
              netRevenueUsd: r.netRevenueUsd,
              grossRevenueUsd: r.grossRevenueUsd,
              source: r.source,
              batchId: r.batchId,
              updatedAt: now,
            })
            .where(and(
              eq(steamSalesDaily.productId, r.productId),
              eq(steamSalesDaily.date, r.date),
              eq(steamSalesDaily.skuGroup, r.skuGroup),
            )).run();
          updated++;
        } else {
          throw err;
        }
      }
    };
    const tx = sqlite.transaction(() => {
      for (const r of rows) runOne(r);
    });
    tx();
    return { inserted, updated };
  }

  /**
   * Wipe all sales rows associated with an upload batch. Used when the
   * user wants to undo an upload. Returns count deleted.
   *
   * v3.13 (2026-08-12) BUGFIX: this previously deleted only the
   * steam_sales_daily rows, leaving the steam_sales_upload_batches metadata
   * row behind. Any re-run of a job that reuses the same deterministic
   * batchId (e.g. portal-daily-backfill's `portal-daily-{productId}-{date}`)
   * would then have createSteamSalesUploadBatch() throw a UNIQUE constraint
   * error on re-insert -- which happened *after* the sales rows were already
   * deleted, so the day's real Steam actuals were wiped and never restored.
   * This silently destroyed production sales-daily history for Space Marine 2
   * (1342 -> 652 rows) and caused ~40% day failures on Toxic Commando's
   * backfill. Now also deletes the stale batch metadata row so re-inserts
   * succeed and the delete+recreate is truly idempotent.
   */
  deleteSteamSalesByBatch(batchId: string): number {
    const res = db.delete(steamSalesDaily)
      .where(eq(steamSalesDaily.batchId, batchId)).run();
    db.delete(steamSalesUploadBatches)
      .where(eq(steamSalesUploadBatches.id, batchId)).run();
    return res.changes as number;
  }

  // ─── Steam Sales Upload Batches ──────────────────────────────────────────

  createSteamSalesUploadBatch(data: InsertSteamSalesUploadBatch): SteamSalesUploadBatch {
    const now = this.now();
    return db.insert(steamSalesUploadBatches).values({
      ...data,
      createdAt: now,
    }).returning().get();
  }

  getSteamSalesUploadBatches(productId: number): SteamSalesUploadBatch[] {
    return db.select().from(steamSalesUploadBatches)
      .where(eq(steamSalesUploadBatches.productId, productId))
      .orderBy(desc(steamSalesUploadBatches.createdAt)).all();
  }

  getSteamSalesUploadBatch(id: string): SteamSalesUploadBatch | undefined {
    return db.select().from(steamSalesUploadBatches)
      .where(eq(steamSalesUploadBatches.id, id)).get();
  }

  // ─── Steamworks Session Cookies ─────────────────────────────────────────

  getSteamworksSession(id: string): SteamworksSession | undefined {
    return db.select().from(steamworksSessions)
      .where(eq(steamworksSessions.id, id)).get();
  }

  upsertSteamworksSession(data: InsertSteamworksSession): SteamworksSession {
    const now = this.now();
    const existing = db.select().from(steamworksSessions).where(eq(steamworksSessions.id, data.id)).get();
    if (!existing) {
      return db.insert(steamworksSessions).values({
        ...data,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
    }
    return db.update(steamworksSessions)
      .set({
        cookieValue: data.cookieValue,
        loggedInAs: data.loggedInAs,
        lastVerifiedAt: data.lastVerifiedAt,
        lastVerifiedResult: data.lastVerifiedResult,
        // v3.18 fix: verify-only callers (test-fetch, ingestion success/
        // failure paths) call this with cookieValue/lastVerified* only and
        // omit refreshSource entirely -- they must NOT wipe out who/what
        // last refreshed the cookie. Only overwrite provenance when the
        // caller explicitly supplied it (the cookie-save route always does,
        // defaulting to "manual" server-side). `undefined` = not supplied
        // -> preserve; `null` or a string = an explicit value to write.
        refreshSource: data.refreshSource !== undefined ? data.refreshSource : existing.refreshSource,
        // v3.19: same preserve-unless-explicit pattern as refreshSource.
        // Only the cookie-save route explicitly clears this (to null) when
        // a fresh cookie satisfies a pending manual refresh request; every
        // verify-only caller omits it and leaves it untouched.
        refreshRequestedAt: data.refreshRequestedAt !== undefined ? data.refreshRequestedAt : existing.refreshRequestedAt,
        // v3.20: SAME preserve-unless-explicit pattern. This is the critical
        // one -- ingestSteamSales() calls upsertSteamworksSession on every
        // successful/failed daily fetch with only cookieValue/lastVerified*
        // set. If refreshTokenValue defaulted to undefined-wipes-to-null
        // here, the very first ingestion run after capture would silently
        // erase the refresh token and the whole auto-refresh system would
        // die without anyone noticing. Only the capture-refresh-token route
        // explicitly supplies this field.
        refreshTokenValue: data.refreshTokenValue !== undefined ? data.refreshTokenValue : existing.refreshTokenValue,
        updatedAt: now,
      })
      .where(eq(steamworksSessions.id, data.id))
      .returning().get();
  }

  // Sets the "a human clicked Request agent refresh in Settings" flag.
  // Does not touch cookieValue/loggedInAs/verification fields at all --
  // this is a request marker for the agent (on-demand chat ask, or the
  // nightly self-heal check) to notice, not a live trigger.
  requestSteamworksSessionRefresh(id: string): SteamworksSession | undefined {
    const now = this.now();
    const existing = db.select().from(steamworksSessions).where(eq(steamworksSessions.id, id)).get();
    if (!existing) return undefined;
    return db.update(steamworksSessions)
      .set({ refreshRequestedAt: now, updatedAt: now })
      .where(eq(steamworksSessions.id, id))
      .returning().get();
  }

  // Records the outcome of an agent-driven cookie auto-refresh ATTEMPT,
  // independent of whether it resulted in a saved cookie. Called for both
  // successful and failed attempts (e.g. "no browser available") so the
  // Settings UI can show real auto-refresh health history rather than
  // only ever reflecting the last successful save.
  logSteamworksSessionRefreshAttempt(id: string, attemptedAt: string, result: string): void {
    const existing = db.select().from(steamworksSessions).where(eq(steamworksSessions.id, id)).get();
    if (!existing) return; // nothing configured yet — nothing to annotate
    db.update(steamworksSessions)
      .set({ autoRefreshLastAttemptAt: attemptedAt, autoRefreshLastResult: result })
      .where(eq(steamworksSessions.id, id))
      .run();
  }

  deleteSteamworksSession(id: string): boolean {
    const res = db.delete(steamworksSessions)
      .where(eq(steamworksSessions.id, id)).run();
    return (res.changes as number) > 0;
  }

  setSteamworksSessionAlertSent(id: string, alertSentAt: string | null): void {
    db.update(steamworksSessions)
      .set({ alertSentAt, updatedAt: this.now() })
      .where(eq(steamworksSessions.id, id))
      .run();
  }

  // ─── Steam Followers (Steam Leaderboards — Wishlist board) ─────────────
  // Public-scrape-only source (steamcommunity.com memberslistxml) — see
  // schema.ts comment and CLAUDE_STEAM_LEADERBOARDS.md §9.2. dailyDelta is
  // signed and intentionally NOT clamped to >= 0 (a title can lose followers).

  getSteamFollowers(productId: number): SteamFollowersDaily[] {
    return db.select().from(steamFollowersDaily)
      .where(eq(steamFollowersDaily.productId, productId))
      .orderBy(asc(steamFollowersDaily.date)).all();
  }

  getLatestSteamFollowers(productId: number): SteamFollowersDaily | undefined {
    return db.select().from(steamFollowersDaily)
      .where(eq(steamFollowersDaily.productId, productId))
      .orderBy(desc(steamFollowersDaily.date))
      .limit(1).get();
  }

  upsertSteamFollowers(data: InsertSteamFollowers): SteamFollowersDaily {
    const existing = db.select().from(steamFollowersDaily)
      .where(and(eq(steamFollowersDaily.productId, data.productId), eq(steamFollowersDaily.date, data.date)))
      .get();
    if (existing) {
      return db.update(steamFollowersDaily)
        .set({ followerCount: data.followerCount, dailyDelta: data.dailyDelta, source: data.source })
        .where(eq(steamFollowersDaily.id, existing.id))
        .returning().get();
    }
    return db.insert(steamFollowersDaily).values({
      ...data,
      createdAt: this.now(),
    }).returning().get();
  }

  // ─── Steam Wishlist Rank (Steam Leaderboards — Wishlist board) ───────────
  // Top-200 public "popularwishlist" listing — see schema.ts comment and
  // CLAUDE_STEAM_LEADERBOARDS.md §9.5. rank is null when outside top-200.

  getSteamWishlistRanks(productId: number): SteamWishlistRankDaily[] {
    return db.select().from(steamWishlistRankDaily)
      .where(eq(steamWishlistRankDaily.productId, productId))
      .orderBy(asc(steamWishlistRankDaily.date)).all();
  }

  getLatestSteamWishlistRank(productId: number): SteamWishlistRankDaily | undefined {
    return db.select().from(steamWishlistRankDaily)
      .where(eq(steamWishlistRankDaily.productId, productId))
      .orderBy(desc(steamWishlistRankDaily.date))
      .limit(1).get();
  }

  // Finds the row closest to (latest row's date - daysAgo), never a row
  // AFTER that target date. Mirrors the "latest known value strictly
  // before X" pattern used elsewhere in this file, so a missed ingestion
  // day doesn't break the 7-day delta — it just uses the closest available
  // prior snapshot.
  getSteamWishlistRankDaysAgo(productId: number, daysAgo: number): SteamWishlistRankDaily | undefined {
    const rows = this.getSteamWishlistRanks(productId); // ascending by date
    if (rows.length === 0) return undefined;
    const latestDate = rows[rows.length - 1].date;
    const target = new Date(`${latestDate}T00:00:00Z`);
    target.setUTCDate(target.getUTCDate() - daysAgo);
    const targetStr = target.toISOString().split("T")[0];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].date <= targetStr) return rows[i];
    }
    return undefined;
  }

  upsertSteamWishlistRank(data: InsertSteamWishlistRank): SteamWishlistRankDaily {
    const existing = db.select().from(steamWishlistRankDaily)
      .where(and(eq(steamWishlistRankDaily.productId, data.productId), eq(steamWishlistRankDaily.date, data.date)))
      .get();
    if (existing) {
      return db.update(steamWishlistRankDaily)
        .set({ rank: data.rank })
        .where(eq(steamWishlistRankDaily.id, existing.id))
        .returning().get();
    }
    return db.insert(steamWishlistRankDaily).values({
      ...data,
      createdAt: this.now(),
    }).returning().get();
  }

  // ─── IGDB Hype (Steam Leaderboards — Wishlist board) ─────────────────

  getIgdbHypeHistory(productId: number): IgdbHypeDaily[] {
    return db.select().from(igdbHypeDaily)
      .where(eq(igdbHypeDaily.productId, productId))
      .orderBy(asc(igdbHypeDaily.date)).all();
  }

  getLatestIgdbHype(productId: number): IgdbHypeDaily | undefined {
    return db.select().from(igdbHypeDaily)
      .where(eq(igdbHypeDaily.productId, productId))
      .orderBy(desc(igdbHypeDaily.date))
      .limit(1).get();
  }

  upsertIgdbHype(data: InsertIgdbHype): IgdbHypeDaily {
    const existing = db.select().from(igdbHypeDaily)
      .where(and(eq(igdbHypeDaily.productId, data.productId), eq(igdbHypeDaily.date, data.date)))
      .get();
    if (existing) {
      return db.update(igdbHypeDaily)
        .set({ igdbId: data.igdbId, hypeScore: data.hypeScore })
        .where(eq(igdbHypeDaily.id, existing.id))
        .returning().get();
    }
    return db.insert(igdbHypeDaily).values({
      ...data,
      createdAt: this.now(),
    }).returning().get();
  }

  // ─── PS5 Wishlists ───────────────────────────────────────────────────────────

  getPs5Wishlists(productId: number): Ps5WishlistDaily[] {
    return db.select().from(ps5WishlistDaily)
      .where(eq(ps5WishlistDaily.productId, productId))
      .orderBy(asc(ps5WishlistDaily.date)).all();
  }

  getLatestPs5Wishlist(productId: number): Ps5WishlistDaily | undefined {
    return db.select().from(ps5WishlistDaily)
      .where(eq(ps5WishlistDaily.productId, productId))
      .orderBy(desc(ps5WishlistDaily.date))
      .limit(1).get();
  }

  addPs5Wishlist(data: InsertPs5Wishlist): Ps5WishlistDaily {
    const now = this.now();
    try {
      return db.insert(ps5WishlistDaily).values({
        ...data,
        createdAt: now,
      }).returning().get();
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return db.update(ps5WishlistDaily)
          .set({ cumulativeCount: data.cumulativeCount, dailyDelta: data.dailyDelta, source: data.source })
          .where(and(eq(ps5WishlistDaily.productId, data.productId), eq(ps5WishlistDaily.date, data.date)))
          .returning().get();
      }
      throw err;
    }
  }

  // ─── PS5 Prepurchases ────────────────────────────────────────────────────────

  getPs5Prepurchases(productId: number): Ps5PrepurchaseDaily[] {
    return db.select().from(ps5PrepurchaseDaily)
      .where(eq(ps5PrepurchaseDaily.productId, productId))
      .orderBy(asc(ps5PrepurchaseDaily.date)).all();
  }

  getLatestPs5Prepurchase(productId: number): Ps5PrepurchaseDaily | undefined {
    return db.select().from(ps5PrepurchaseDaily)
      .where(eq(ps5PrepurchaseDaily.productId, productId))
      .orderBy(desc(ps5PrepurchaseDaily.date))
      .limit(1).get();
  }

  addPs5Prepurchase(data: InsertPs5Prepurchase): Ps5PrepurchaseDaily {
    const now = this.now();
    try {
      return db.insert(ps5PrepurchaseDaily).values({
        ...data,
        createdAt: now,
      }).returning().get();
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return db.update(ps5PrepurchaseDaily)
          .set({ cumulativeCount: data.cumulativeCount, dailyDelta: data.dailyDelta, source: data.source })
          .where(and(eq(ps5PrepurchaseDaily.productId, data.productId), eq(ps5PrepurchaseDaily.date, data.date)))
          .returning().get();
      }
      throw err;
    }
  }

  // ─── Dynamic Forecasts ───────────────────────────────────────────────────────

  getDynamicForecasts(productId: number): DynamicForecastDaily[] {
    return db.select().from(dynamicForecastsDaily)
      .where(eq(dynamicForecastsDaily.productId, productId))
      .orderBy(asc(dynamicForecastsDaily.date)).all();
  }

  getLatestDynamicForecasts(productId: number): DynamicForecastDaily[] {
    // Get the latest date for this product
    const latest = db.select().from(dynamicForecastsDaily)
      .where(eq(dynamicForecastsDaily.productId, productId))
      .orderBy(desc(dynamicForecastsDaily.date))
      .limit(1).get();
    
    if (!latest) return [];

    return db.select().from(dynamicForecastsDaily)
      .where(and(
        eq(dynamicForecastsDaily.productId, productId),
        eq(dynamicForecastsDaily.date, latest.date),
      )).all();
  }

  upsertDynamicForecasts(forecasts: InsertDynamicForecast[]): void {
    const now = this.now();
    for (const f of forecasts) {
      // Try to update first, then insert
      const existing = db.select().from(dynamicForecastsDaily)
        .where(and(
          eq(dynamicForecastsDaily.productId, f.productId),
          eq(dynamicForecastsDaily.date, f.date),
          eq(dynamicForecastsDaily.platform, f.platform),
        )).get();

      if (existing) {
        db.update(dynamicForecastsDaily)
          .set({ forecastUnits: f.forecastUnits, steamWishlistCountUsed: f.steamWishlistCountUsed, ps5PrepurchaseCountUsed: f.ps5PrepurchaseCountUsed })
          .where(eq(dynamicForecastsDaily.id, existing.id)).run();
      } else {
        db.insert(dynamicForecastsDaily).values({
          ...f,
          createdAt: now,
        }).run();
      }
    }
  }

  // ─── PLS Milestones ──────────────────────────────────────────────────────────

  getPlsMilestones(productId: number): PlsMilestone[] {
    return db.select().from(plsMilestones)
      .where(and(
        eq(plsMilestones.productId, productId),
        isNull(plsMilestones.deletedAt),
      ))
      .orderBy(asc(plsMilestones.sortOrder)).all();
  }

  /**
   * Returns the product's release date (YYYY-MM-DD) or null if unknown.
   *
   * Resolution order (2026-08-11 fix):
   *   1. Release milestone's actualDate (most authoritative when the game
   *      has actually shipped and someone recorded the real date).
   *   2. Fall back to the products.release_date column, which is required
   *      on every product and set to the target/actual release date.
   *
   * The milestone check comes first because a game that slipped will have
   * an OLDER products.release_date than reality; the milestone's
   * actualDate captures the true shipped date. But most Saber products
   * don't have a 'Release' milestone in the default template (they have
   * 'Launch Trailer', 'Prepurchase Start', etc.), so the fallback is
   * required for those.
   */
  getProductReleaseDate(productId: number): string | null {
    const milestones = this.getPlsMilestones(productId);
    const release = milestones.find(m => m.name === "Release");
    if (release?.actualDate) return release.actualDate;

    // Fallback: products.release_date column.
    const product = this.getProduct(productId);
    return product?.releaseDate ?? null;
  }

  createPlsMilestone(data: InsertPlsMilestone): PlsMilestone {
    const now = this.now();
    return db.insert(plsMilestones).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
  }

  updatePlsMilestone(id: number, data: Partial<InsertPlsMilestone>): PlsMilestone | undefined {
    const now = this.now();
    return db.update(plsMilestones)
      .set({ ...data, updatedAt: now })
      .where(eq(plsMilestones.id, id))
      .returning().get();
  }

  deletePlsMilestone(id: number): void {
    const now = this.now();
    db.update(plsMilestones)
      .set({ deletedAt: now })
      .where(eq(plsMilestones.id, id)).run();
  }

  // ─── YouTube Links ───────────────────────────────────────────────────────────

  getYoutubeLinks(milestoneId: number): YoutubeLink[] {
    return db.select().from(plsVideoYoutubeLinks)
      .where(eq(plsVideoYoutubeLinks.milestoneId, milestoneId)).all();
  }

  addYoutubeLink(data: InsertYoutubeLink): YoutubeLink {
    return db.insert(plsVideoYoutubeLinks).values({
      ...data,
      createdAt: this.now(),
    }).returning().get();
  }

  deleteYoutubeLink(id: number): void {
    db.delete(plsVideoYoutubeLinks).where(eq(plsVideoYoutubeLinks.id, id)).run();
  }

  // ─── YouTube Daily ───────────────────────────────────────────────────────────

  getYoutubeViews(linkId: number): YoutubeVideoDaily[] {
    return db.select().from(youtubeVideoDaily)
      .where(eq(youtubeVideoDaily.youtubeLinkId, linkId))
      .orderBy(asc(youtubeVideoDaily.date)).all();
  }

  addYoutubeVideoDaily(data: { youtubeLinkId: number; date: string; cumulativeViews: number; dailyDelta: number }): YoutubeVideoDaily {
    // Upsert: update if same link+date exists, otherwise insert
    const existing = db.select().from(youtubeVideoDaily)
      .where(and(
        eq(youtubeVideoDaily.youtubeLinkId, data.youtubeLinkId),
        eq(youtubeVideoDaily.date, data.date),
      )).get();

    if (existing) {
      return db.update(youtubeVideoDaily)
        .set({
          cumulativeViews: data.cumulativeViews,
          dailyDelta: data.dailyDelta,
        })
        .where(eq(youtubeVideoDaily.id, existing.id))
        .returning().get();
    }

    return db.insert(youtubeVideoDaily).values({
      youtubeLinkId: data.youtubeLinkId,
      date: data.date,
      cumulativeViews: data.cumulativeViews,
      dailyDelta: data.dailyDelta,
      createdAt: this.now(),
    }).returning().get();
  }

  getAllYoutubeLinks(): YoutubeLink[] {
    return db.select().from(plsVideoYoutubeLinks).all();
  }

  getAggregateYoutubeViews(milestoneId: number): {
    totalViews: number;
    officialViews: number;
    reuploadViews: number;
    videos: Array<{
      link: YoutubeLink;
      latestViews: number;
      dailyData: YoutubeVideoDaily[];
    }>;
    aggregateTimeSeries: Array<{ date: string; cumulativeViews: number; dailyDelta: number }>;
  } {
    const links = this.getYoutubeLinks(milestoneId);
    let totalViews = 0;
    let officialViews = 0;
    let reuploadViews = 0;

    const videos: Array<{
      link: YoutubeLink;
      latestViews: number;
      dailyData: YoutubeVideoDaily[];
    }> = [];

    // Map of date -> { cumulative sum, delta sum }
    const dateMap = new Map<string, { cumulativeViews: number; dailyDelta: number }>();

    for (const link of links) {
      const dailyData = this.getYoutubeViews(link.id);
      const latestEntry = dailyData.length > 0 ? dailyData[dailyData.length - 1] : null;
      const latestViews = latestEntry?.cumulativeViews ?? 0;

      totalViews += latestViews;
      if (link.isOfficial) {
        officialViews += latestViews;
      } else {
        reuploadViews += latestViews;
      }

      videos.push({ link, latestViews, dailyData });

      // Aggregate time series across all videos
      for (const entry of dailyData) {
        const existing = dateMap.get(entry.date);
        if (existing) {
          existing.cumulativeViews += entry.cumulativeViews;
          existing.dailyDelta += entry.dailyDelta;
        } else {
          dateMap.set(entry.date, {
            cumulativeViews: entry.cumulativeViews,
            dailyDelta: entry.dailyDelta,
          });
        }
      }
    }

    // Sort aggregate time series by date
    const aggregateTimeSeries = Array.from(dateMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        cumulativeViews: data.cumulativeViews,
        dailyDelta: data.dailyDelta,
      }));

    return { totalViews, officialViews, reuploadViews, videos, aggregateTimeSeries };
  }

  // ─── Launch Forecast Snapshot (v3.22) ────────────────────────────────────
  //
  // Written exactly once per product, the first time the dashboard route
  // observes releaseDate <= today. Never rewritten. The card compares the
  // live actuals-influenced forecast to this locked baseline for 1 year
  // post-release.
  upsertLaunchForecastSnapshotIfMissing(data: InsertLaunchForecastSnapshot): LaunchForecastSnapshot {
    const existing = db.select().from(launchForecastSnapshots)
      .where(eq(launchForecastSnapshots.productId, data.productId)).get();
    if (existing) return existing;
    const now = this.now();
    return db.insert(launchForecastSnapshots).values({
      ...data,
      createdAt: now,
    }).returning().get();
  }

  getLaunchForecastSnapshot(productId: number): LaunchForecastSnapshot | null {
    return db.select().from(launchForecastSnapshots)
      .where(eq(launchForecastSnapshots.productId, productId)).get() ?? null;
  }

  // ─── App Settings ───────────────────────────────────────────────────────────

  getAllSettings(): AppSetting[] {
    return db.select().from(appSettings).all();
  }

  getSetting(key: string): AppSetting | undefined {
    return db.select().from(appSettings)
      .where(eq(appSettings.key, key)).get();
  }

  upsertSetting(key: string, value: string): AppSetting {
    const now = this.now();
    const existing = this.getSetting(key);
    if (existing) {
      return db.update(appSettings)
        .set({ value, updatedAt: now })
        .where(eq(appSettings.key, key))
        .returning().get();
    }
    return db.insert(appSettings).values({
      key, value, label: key, category: "general", isSecret: false,
      createdAt: now, updatedAt: now,
    }).returning().get();
  }

  seedDefaultSettings(): void {
    const now = this.now();
    const defaults: { key: string; label: string; category: string; isSecret: boolean; value?: string }[] = [
      { key: "steam_api_key", label: "Steam Web API Key", category: "api_keys", isSecret: true },
      { key: "steam_partner_id", label: "Steam Partner ID", category: "api_keys", isSecret: false },
      { key: "sony_api_key", label: "Sony Partner Portal API Key", category: "api_keys", isSecret: true },
      { key: "sony_partner_id", label: "Sony Partner ID", category: "api_keys", isSecret: false },
      { key: "youtube_api_key", label: "YouTube Data API Key", category: "api_keys", isSecret: true },
      { key: "perplexity_api_key", label: "Perplexity API Key", category: "api_keys", isSecret: true },
      { key: "twitch_client_id", label: "Twitch Client ID (IGDB)", category: "api_keys", isSecret: false },
      { key: "twitch_client_secret", label: "Twitch Client Secret (IGDB)", category: "api_keys", isSecret: true },
      { key: "app_password", label: "App Password", category: "general", isSecret: true },
      { key: "resend_api_key", label: "Resend API Key", category: "email", isSecret: true },
      { key: "resend_from", label: "Resend From Address", category: "email", isSecret: false, value: "onboarding@resend.dev" },
      // v3.21 (2026-08-15): inbound email via Resend webhook.
      { key: "resend_inbound_signing_secret", label: "Resend Inbound Webhook Signing Secret (whsec_...)", category: "email", isSecret: true },
      { key: "resend_inbound_receiving_domain", label: "Resend Inbound Receiving Domain", category: "email", isSecret: false, value: "howmanyareplaying.com" },
      { key: "resend_inbound_forward_enabled", label: "Forward inbound to personal inbox", category: "email", isSecret: false, value: "true" },
      { key: "resend_inbound_forward_to", label: "Forward inbound to this address", category: "email", isSecret: false, value: "steve.allison.home@gmail.com" },
    ];

    for (const d of defaults) {
      const existing = this.getSetting(d.key);
      if (!existing) {
        db.insert(appSettings).values({
          key: d.key,
          value: d.key === "app_password" ? "SABER" : (d.value ?? ""),
          label: d.label,
          category: d.category,
          isSecret: d.isSecret,
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    }
  }

  // ─── Leaderboard Weekly Email Recipients ──────────────────────────────────────

  getLeaderboardEmailRecipients(): LeaderboardEmailRecipient[] {
    return db.select().from(leaderboardEmailRecipients)
      .orderBy(asc(leaderboardEmailRecipients.createdAt)).all();
  }

  getActiveLeaderboardEmailRecipients(): LeaderboardEmailRecipient[] {
    return db.select().from(leaderboardEmailRecipients)
      .where(eq(leaderboardEmailRecipients.isActive, true))
      .orderBy(asc(leaderboardEmailRecipients.createdAt)).all();
  }

  createLeaderboardEmailRecipient(data: InsertLeaderboardEmailRecipient): LeaderboardEmailRecipient {
    const now = this.now();
    return db.insert(leaderboardEmailRecipients).values({
      ...data,
      createdAt: now,
    }).returning().get();
  }

  updateLeaderboardEmailRecipient(id: number, data: Partial<InsertLeaderboardEmailRecipient>): LeaderboardEmailRecipient | undefined {
    return db.update(leaderboardEmailRecipients)
      .set(data)
      .where(eq(leaderboardEmailRecipients.id, id))
      .returning().get();
  }

  deleteLeaderboardEmailRecipient(id: number): void {
    db.delete(leaderboardEmailRecipients).where(eq(leaderboardEmailRecipients.id, id)).run();
  }

  // ─── Inbound email (v3.21, 2026-08-15) ─────────────────────────────
  // Uses raw SQL via the sqlite handle rather than Drizzle schema so we
  // don't need to add a second layer of type definitions for tables that
  // are already created via CREATE TABLE IF NOT EXISTS above.

  insertInboundMessage(data: InsertInboundMessage): InboundMessage {
    const stmt = sqlite.prepare(`
      INSERT INTO inbound_messages (
        resend_email_id, message_id, in_reply_to, references_hdr, thread_key,
        subject, from_addr, from_email, to_addrs, cc_addrs,
        body_text, body_html, snippet, raw_json,
        is_read, is_archived, direction, outbound_status, outbound_error,
        received_at, created_at
      ) VALUES (
        @resend_email_id, @message_id, @in_reply_to, @references_hdr, @thread_key,
        @subject, @from_addr, @from_email, @to_addrs, @cc_addrs,
        @body_text, @body_html, @snippet, @raw_json,
        @is_read, @is_archived, @direction, @outbound_status, @outbound_error,
        @received_at, @created_at
      )
      RETURNING *
    `);
    return stmt.get(data as unknown as Record<string, unknown>) as InboundMessage;
  }

  getInboundMessage(id: number): InboundMessage | undefined {
    return sqlite
      .prepare(`SELECT * FROM inbound_messages WHERE id = ?`)
      .get(id) as InboundMessage | undefined;
  }

  getInboundByResendEmailId(resendEmailId: string): InboundMessage | undefined {
    return sqlite
      .prepare(`SELECT * FROM inbound_messages WHERE resend_email_id = ?`)
      .get(resendEmailId) as InboundMessage | undefined;
  }

  getInboundByMessageId(messageId: string): InboundMessage | undefined {
    return sqlite
      .prepare(`SELECT * FROM inbound_messages WHERE message_id = ?`)
      .get(messageId) as InboundMessage | undefined;
  }

  listInboundMessages(opts: { includeArchived?: boolean; limit?: number; offset?: number }): InboundMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    // Group by thread — return the LATEST message per thread_key so the
    // inbox list shows one row per conversation with the most recent activity.
    const where = opts.includeArchived ? "1=1" : "is_archived = 0";
    const sql = `
      SELECT m.*
      FROM inbound_messages m
      JOIN (
        SELECT thread_key, MAX(received_at) AS max_received
        FROM inbound_messages
        WHERE ${where}
        GROUP BY thread_key
      ) latest
        ON m.thread_key = latest.thread_key
       AND m.received_at = latest.max_received
      WHERE ${where}
      ORDER BY m.received_at DESC
      LIMIT ? OFFSET ?
    `;
    return sqlite.prepare(sql).all(limit, offset) as InboundMessage[];
  }

  listInboundThread(threadKey: string): InboundMessage[] {
    return sqlite
      .prepare(`SELECT * FROM inbound_messages WHERE thread_key = ? ORDER BY received_at ASC`)
      .all(threadKey) as InboundMessage[];
  }

  countUnreadInbound(): number {
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM inbound_messages WHERE is_read = 0 AND is_archived = 0 AND direction = 'inbound'`)
      .get() as { n: number };
    return row?.n ?? 0;
  }

  markInboundRead(id: number, read: boolean): void {
    sqlite
      .prepare(`UPDATE inbound_messages SET is_read = ? WHERE id = ?`)
      .run(read ? 1 : 0, id);
  }

  archiveInbound(id: number, archived: boolean): void {
    sqlite
      .prepare(`UPDATE inbound_messages SET is_archived = ? WHERE id = ?`)
      .run(archived ? 1 : 0, id);
  }

  insertInboundAttachment(data: InsertInboundAttachment): InboundAttachment {
    return sqlite
      .prepare(`
        INSERT INTO inbound_attachments (message_id, filename, content_type, size_bytes, download_url, created_at)
        VALUES (@message_id, @filename, @content_type, @size_bytes, @download_url, @created_at)
        RETURNING *
      `)
      .get(data as unknown as Record<string, unknown>) as InboundAttachment;
  }

  listInboundAttachments(messageId: number): InboundAttachment[] {
    return sqlite
      .prepare(`SELECT * FROM inbound_attachments WHERE message_id = ? ORDER BY id ASC`)
      .all(messageId) as InboundAttachment[];
  }
}

export const storage = new DatabaseStorage();
