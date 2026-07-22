import {
  type Product, type InsertProduct, products,
  type ForecastComps, type InsertForecastComps, productForecastsComps,
  type SteamWishlistDaily, type InsertSteamWishlist, steamWishlistDaily,
  type SteamWishlistReportingDaily, type InsertSteamWishlistReporting, steamWishlistReportingDaily,
  type SteamPrepurchaseDaily, type InsertSteamPrepurchase, steamPrepurchaseDaily,
  type Ps5WishlistDaily, type InsertPs5Wishlist, ps5WishlistDaily,
  type Ps5PrepurchaseDaily, type InsertPs5Prepurchase, ps5PrepurchaseDaily,
  type DynamicForecastDaily, type InsertDynamicForecast, dynamicForecastsDaily,
  type PlsMilestone, type InsertPlsMilestone, plsMilestones,
  type YoutubeLink, type InsertYoutubeLink, plsVideoYoutubeLinks,
  type YoutubeVideoDaily, type InsertYoutubeVideoDaily, youtubeVideoDaily,
  type ForecastRevision, type InsertForecastRevision, forecastRevisions,
  type AppSetting, type InsertAppSetting, appSettings,
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
  `);
}

initializeDatabase();

// ─── Storage Interface ───────────────────────────────────────────────────────

export interface IStorage {
  // Products
  getAllProducts(): Product[];
  getProduct(id: number): Product | undefined;
  createProduct(product: InsertProduct): Product;
  updateProduct(id: number, data: Partial<InsertProduct>): Product | undefined;
  deleteProduct(id: number): void;

  // Forecasts (Comps)
  getCompForecasts(productId: number): ForecastComps[];
  upsertCompForecasts(productId: number, forecasts: { platform: string; forecastUnits: number; adjustedPct: number }[]): ForecastComps[];

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

  // Steam Prepurchases
  getSteamPrepurchases(productId: number): SteamPrepurchaseDaily[];
  getLatestSteamPrepurchase(productId: number): SteamPrepurchaseDaily | undefined;
  addSteamPrepurchase(data: InsertSteamPrepurchase): SteamPrepurchaseDaily;

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

  // Forecast Revisions
  createForecastRevision(productId: number, forecasts: { platform: string; forecastUnits: number }[], revisionDate: string, revisionLabel: string): ForecastRevision[];
  getForecastRevisions(productId: number): ForecastRevision[];
  getLatestRevisionTotal(productId: number): { total: number; date: string } | null;

  // App Settings
  getAllSettings(): AppSetting[];
  getSetting(key: string): AppSetting | undefined;
  upsertSetting(key: string, value: string): AppSetting;
  seedDefaultSettings(): void;
}

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

  // ─── Comps Forecasts ────────────────────────────────────────────────────────

  getCompForecasts(productId: number): ForecastComps[] {
    return db.select().from(productForecastsComps)
      .where(eq(productForecastsComps.productId, productId)).all();
  }

  upsertCompForecasts(productId: number, forecasts: { platform: string; forecastUnits: number; adjustedPct: number }[]): ForecastComps[] {
    const now = this.now();
    // Delete existing for this product
    db.delete(productForecastsComps)
      .where(eq(productForecastsComps.productId, productId)).run();
    
    const results: ForecastComps[] = [];
    for (const f of forecasts) {
      const result = db.insert(productForecastsComps).values({
        productId,
        platform: f.platform,
        forecastUnits: f.forecastUnits,
        adjustedPct: f.adjustedPct,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      results.push(result);
    }
    return results;
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

  // ─── Forecast Revisions ─────────────────────────────────────────────────────

  createForecastRevision(productId: number, forecasts: { platform: string; forecastUnits: number }[], revisionDate: string, revisionLabel: string): ForecastRevision[] {
    const now = this.now();
    const results: ForecastRevision[] = [];
    for (const f of forecasts) {
      const result = db.insert(forecastRevisions).values({
        productId,
        platform: f.platform,
        forecastUnits: f.forecastUnits,
        revisionDate,
        revisionLabel,
        createdAt: now,
      }).returning().get();
      results.push(result);
    }
    return results;
  }

  getForecastRevisions(productId: number): ForecastRevision[] {
    return db.select().from(forecastRevisions)
      .where(eq(forecastRevisions.productId, productId))
      .orderBy(asc(forecastRevisions.revisionDate)).all();
  }

  getLatestRevisionTotal(productId: number): { total: number; date: string } | null {
    // Get the latest revision date
    const latest = db.select().from(forecastRevisions)
      .where(eq(forecastRevisions.productId, productId))
      .orderBy(desc(forecastRevisions.revisionDate))
      .limit(1).get();
    if (!latest) return null;

    // Sum all platform units for that revision date
    const rows = db.select().from(forecastRevisions)
      .where(and(
        eq(forecastRevisions.productId, productId),
        eq(forecastRevisions.revisionDate, latest.revisionDate),
      )).all();
    return {
      total: rows.reduce((sum, r) => sum + r.forecastUnits, 0),
      date: latest.revisionDate,
    };
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
    const defaults: { key: string; label: string; category: string; isSecret: boolean }[] = [
      { key: "steam_api_key", label: "Steam Web API Key", category: "api_keys", isSecret: true },
      { key: "steam_partner_id", label: "Steam Partner ID", category: "api_keys", isSecret: false },
      { key: "sony_api_key", label: "Sony Partner Portal API Key", category: "api_keys", isSecret: true },
      { key: "sony_partner_id", label: "Sony Partner ID", category: "api_keys", isSecret: false },
      { key: "youtube_api_key", label: "YouTube Data API Key", category: "api_keys", isSecret: true },
      { key: "app_password", label: "App Password", category: "general", isSecret: true },
    ];

    for (const d of defaults) {
      const existing = this.getSetting(d.key);
      if (!existing) {
        db.insert(appSettings).values({
          key: d.key,
          value: d.key === "app_password" ? "SABER" : "",
          label: d.label,
          category: d.category,
          isSecret: d.isSecret,
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    }
  }
}

export const storage = new DatabaseStorage();
