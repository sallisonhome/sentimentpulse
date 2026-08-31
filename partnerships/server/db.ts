import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";
import fs from "fs";

// Partnerships' own SQLite DB. Colocated next to the server (matches
// SignalPulse's `data.db` pattern). In production the working directory is
// /opt/sentimentpulse/partnerships so this resolves to
// /opt/sentimentpulse/partnerships/data.db.
const DB_PATH = process.env.PARTNERSHIPS_DB_PATH || "data.db";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

// Bootstrap: create tables if they don't exist. We're intentionally not
// running drizzle migrations here (SignalPulse doesn't either) — schema is
// small and creation is idempotent.
export function initSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      bucket TEXT NOT NULL,
      subtype TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL,
      revenue_usd REAL,
      marketing_name TEXT,
      marketing_platform TEXT,
      marketing_start_date TEXT,
      marketing_end_date TEXT,
      marketing_value_usd REAL,
      marketing_reach INTEGER,
      marketing_impact TEXT,
      details TEXT,
      extra_json TEXT,
      flagged_removed_at TEXT,
      flagged_reason TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS opportunities_product ON opportunities(product_id);
    CREATE INDEX IF NOT EXISTS opportunities_bucket ON opportunities(bucket);
    CREATE INDEX IF NOT EXISTS opportunities_state ON opportunities(state);

    CREATE TABLE IF NOT EXISTS physical_retail_partners (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      partner_name TEXT NOT NULL,
      partner_name_other TEXT,
      territories_json TEXT NOT NULL,
      territory_other_countries_json TEXT,
      mg_amount_usd REAL NOT NULL DEFAULT 0,
      royalty_pct_net REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      details TEXT,
      flagged_removed_at TEXT,
      flagged_reason TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retail_product ON physical_retail_partners(product_id);

    CREATE TABLE IF NOT EXISTS collectors_edition_items (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      opportunity_id TEXT,
      item_name TEXT NOT NULL,
      manufacturing_cost_usd REAL,
      manufacturing_cost_tbd INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ce_items_product ON collectors_edition_items(product_id);

    CREATE TABLE IF NOT EXISTS opportunity_audit_log (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      changes_json TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_entity ON opportunity_audit_log(entity_type, entity_id);
  `);
}

export function dbExists(): boolean {
  return fs.existsSync(path.resolve(DB_PATH));
}
