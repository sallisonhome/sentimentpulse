import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────────────────

// Two independent calendars. Each has its own upload history and event set.
export const CALENDARS = ["saber", "saber_focus"] as const;
export type CalendarId = (typeof CALENDARS)[number];

export const CALENDAR_LABELS: Record<CalendarId, string> = {
  saber: "Saber Promo Calendar",
  saber_focus: "Saber × Focus Promo Calendar",
};

// Platforms we recognize from the sheet's platform-banner rows.
// Unknown banners are recorded verbatim in `platform_raw` and normalized to "Other".
export const PLATFORMS = ["Steam", "Microsoft", "Sony", "Nintendo", "Epic", "Other"] as const;
export type Platform = (typeof PLATFORMS)[number];

// How many prior uploads we keep per calendar for rollback.
export const UPLOAD_HISTORY_LIMIT = 10;

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Every ingest = one row here. Keeps the raw file blob for rollback.
 * Only the most recent `is_active` row per calendar is what powers the API.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    calendar: text("calendar").notNull(), // CalendarId
    filename: text("filename").notNull(),
    file_size_bytes: integer("file_size_bytes").notNull(),
    file_sha256: text("file_sha256").notNull(),
    file_blob: text("file_blob").notNull(), // base64 of the original .xlsx
    uploaded_at: text("uploaded_at").notNull(), // ISO
    uploaded_by: text("uploaded_by"), // free-text owner label; nullable
    events_count: integer("events_count").notNull().default(0),
    campaigns_count: integer("campaigns_count").notNull().default(0),
    parse_warnings: text("parse_warnings").notNull().default("[]"), // JSON array of strings
    is_active: integer("is_active", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
  },
  (t) => ({
    byCalendarActive: index("uploads_by_cal_active").on(t.calendar, t.is_active),
    byUploadedAt: index("uploads_by_uploaded_at").on(t.uploaded_at),
  }),
);

/**
 * One row per (Game, Platform, Program, Start Date, End Date) campaign.
 * SKU-level rows collapse into this; individual SKUs live in `sku_lines`.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    upload_id: integer("upload_id").notNull(), // which ingest produced this
    calendar: text("calendar").notNull(), // CalendarId
    // The tab we found this on (e.g. "SM2 2026", "Snow 2024") — kept verbatim
    // so we can trace back to the source and re-parse without re-ingesting.
    sheet_name: text("sheet_name").notNull(),
    // Normalized game label. We take the raw sheet-name prefix (e.g. "SM2",
    // "Snow", "ISS", "Expe", "RoadCraft", "Toxic Commando") and map it via
    // `GAME_NAME_MAP` to a user-facing label ("Warhammer 40,000: Space Marine 2").
    game_code: text("game_code").notNull(), // raw prefix (upper-cased)
    game_label: text("game_label").notNull(), // display name
    // Which calendar year the sheet is for (SM2 2025 → 2025). Used for grouping/filters.
    sheet_year: integer("sheet_year").notNull(),
    platform: text("platform").notNull(), // Platform enum
    platform_raw: text("platform_raw").notNull(), // banner as written on the sheet
    program: text("program").notNull(), // e.g. "Custom Sales", "Spring Sales"
    start_date: text("start_date").notNull(), // ISO date, no TZ
    end_date: text("end_date").notNull(),
    // Aggregate rollups from SKU lines below:
    sku_count: integer("sku_count").notNull().default(0),
    max_discount_pct: real("max_discount_pct").notNull().default(0), // 0.0-1.0
    min_discount_pct: real("min_discount_pct").notNull().default(0),
    // Optional free-text note picked up from a spillover column (e.g. "tbc", "Release ...")
    notes: text("notes"),
    // Row range on the source sheet, useful for provenance/debugging.
    source_row_start: integer("source_row_start"),
    source_row_end: integer("source_row_end"),
  },
  (t) => ({
    byCalendar: index("camp_by_cal").on(t.calendar),
    byDates: index("camp_by_dates").on(t.calendar, t.start_date, t.end_date),
    byGame: index("camp_by_game").on(t.calendar, t.game_code),
    byPlatform: index("camp_by_platform").on(t.calendar, t.platform),
  }),
);

/**
 * One row per SKU line inside a campaign — the raw sheet row.
 */
export const sku_lines = sqliteTable(
  "sku_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaign_id: integer("campaign_id").notNull(),
    upload_id: integer("upload_id").notNull(),
    content_name: text("content_name").notNull(),
    current_srp_usd: real("current_srp_usd"), // nullable — some sheets have '-' or ''
    promo_srp_usd: real("promo_srp_usd"),
    discount_pct: real("discount_pct"), // 0.0-1.0
    // If the sheet has spillover columns (Release date, Partner override, etc.) we
    // dump them here as JSON so we don't lose data without hard-coding every column.
    extra: text("extra").notNull().default("{}"),
    source_row: integer("source_row"),
  },
  (t) => ({
    byCampaign: index("sku_by_campaign").on(t.campaign_id),
  }),
);

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const insertUploadSchema = createInsertSchema(uploads).omit({
  id: true,
  uploaded_at: true,
  events_count: true,
  campaigns_count: true,
  is_active: true,
});
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploads.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type SkuLine = typeof sku_lines.$inferSelect;

// ─── Constants for the parser ─────────────────────────────────────────────────

/**
 * Mapping from raw sheet-name prefix → display label.
 * Add new prefixes here as new games join the portfolio.
 * Comparison is case-insensitive; the parser upper-cases the prefix.
 */
export const GAME_NAME_MAP: Record<string, string> = {
  SM2: "Warhammer 40,000: Space Marine 2",
  ROADCRAFT: "RoadCraft",
  "TOXIC COMMANDO": "Toxic Commando",
  SNOW: "SnowRunner",
  EXPE: "Expeditions",
  EXPEDITIONS: "Expeditions",
  ISS: "Insurgency: Sandstorm",
};

/**
 * Sheet-name prefixes we treat as reference tabs, not promo data (skipped).
 */
export const IGNORED_SHEET_PREFIXES = ["PRICES", "NOTES", "REFERENCE", "LOOKUP"];

/**
 * Platform-banner text → normalized platform enum.
 */
export const PLATFORM_MAP: Record<string, Platform> = {
  STEAM: "Steam",
  "STEAM ": "Steam", // trailing space common in the sample
  MICROSOFT: "Microsoft",
  XBOX: "Microsoft",
  "MICROSOFT (XBOX)": "Microsoft",
  SONY: "Sony",
  PLAYSTATION: "Sony",
  "PS4/PS5": "Sony",
  NINTENDO: "Nintendo",
  SWITCH: "Nintendo",
  EPIC: "Epic",
  "EPIC GAMES STORE": "Epic",
};
