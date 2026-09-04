import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "../shared/schema.js";

/**
 * Promo Calendar's SQLite DB. Colocated next to the server (matches the
 * Partnerships pattern). In production the working directory is
 * /opt/sentimentpulse/promocalendar so this resolves to
 * /opt/sentimentpulse/promocalendar/data.db.
 */
const DB_PATH = process.env.PROMOCALENDAR_DB_PATH || "data.db";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
export const raw = sqlite;

export function initSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      file_sha256 TEXT NOT NULL,
      file_blob TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      uploaded_by TEXT,
      events_count INTEGER NOT NULL DEFAULT 0,
      campaigns_count INTEGER NOT NULL DEFAULT 0,
      parse_warnings TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS uploads_by_cal_active
      ON uploads(calendar, is_active);
    CREATE INDEX IF NOT EXISTS uploads_by_uploaded_at
      ON uploads(uploaded_at);

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL,
      calendar TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      game_code TEXT NOT NULL,
      game_label TEXT NOT NULL,
      sheet_year INTEGER NOT NULL,
      platform TEXT NOT NULL,
      platform_raw TEXT NOT NULL,
      program TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      sku_count INTEGER NOT NULL DEFAULT 0,
      max_discount_pct REAL NOT NULL DEFAULT 0,
      min_discount_pct REAL NOT NULL DEFAULT 0,
      notes TEXT,
      source_row_start INTEGER,
      source_row_end INTEGER
    );
    CREATE INDEX IF NOT EXISTS camp_by_cal ON campaigns(calendar);
    CREATE INDEX IF NOT EXISTS camp_by_dates
      ON campaigns(calendar, start_date, end_date);
    CREATE INDEX IF NOT EXISTS camp_by_game
      ON campaigns(calendar, game_code);
    CREATE INDEX IF NOT EXISTS camp_by_platform
      ON campaigns(calendar, platform);

    CREATE TABLE IF NOT EXISTS sku_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      upload_id INTEGER NOT NULL,
      content_name TEXT NOT NULL,
      current_srp_usd REAL,
      promo_srp_usd REAL,
      discount_pct REAL,
      extra TEXT NOT NULL DEFAULT '{}',
      source_row INTEGER
    );
    CREATE INDEX IF NOT EXISTS sku_by_campaign
      ON sku_lines(campaign_id);
  `);
}
