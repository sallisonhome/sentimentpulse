import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { PartnershipsTitle } from "@shared/schema";

/**
 * Read-only projection of SignalPulse's `products` table.
 *
 * SignalPulse owns its own SQLite DB at
 * /opt/sentimentpulse/signalpulse/data.db. We open it read-only from
 * this app so titles auto-populate (spec: "will automatically populate
 * for any titles set up in SignalPulse and pull in their key information
 * around name, platforms, release date and launch MSRP"). If SignalPulse
 * ever moves to a different store, this is the only file that needs to
 * change.
 *
 * Cache is process-lifetime + a 60s TTL: the dashboard hits this on
 * every list request but the underlying data changes at most a few
 * times a day.
 */

const DEFAULT_PATH = "../signalpulse/data.db";
const CACHE_TTL_MS = 60_000;

let cache: { at: number; rows: PartnershipsTitle[] } | null = null;
let sqlite: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (sqlite) return sqlite;
  const p = process.env.SIGNALPULSE_DB_PATH || DEFAULT_PATH;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[partnerships] SignalPulse DB not found at ${abs}. Set SIGNALPULSE_DB_PATH or start SignalPulse first. Returning empty title list.`,
    );
    return null;
  }
  sqlite = new Database(abs, { readonly: true, fileMustExist: true });
  return sqlite;
}

/**
 * Return the projected title list. Empty array if SignalPulse DB is missing
 * — the endpoint stays green so the app is usable in isolation for dev.
 */
export function listTitles(): PartnershipsTitle[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const db = getDb();
  if (!db) {
    cache = { at: Date.now(), rows: [] };
    return [];
  }

  // Columns per signalpulse/shared/schema.ts (SQLite):
  //   id, title, platforms (JSON string), release_date, target_retail_price_usd,
  //   steam_app_id, steam_header_image_url
  const rows = db
    .prepare(
      `SELECT id, title, platforms, release_date,
              target_retail_price_usd, steam_app_id, steam_header_image_url
       FROM products
       ORDER BY release_date DESC, title ASC`,
    )
    .all() as Array<{
      id: number;
      title: string;
      platforms: string;
      release_date: string;
      target_retail_price_usd: number | null;
      steam_app_id: string | null;
      steam_header_image_url: string | null;
    }>;

  const out: PartnershipsTitle[] = rows.map((r) => {
    let platforms: string[] = [];
    try {
      const parsed = JSON.parse(r.platforms);
      if (Array.isArray(parsed)) platforms = parsed.map(String);
    } catch {
      // Non-JSON, treat as comma-separated fallback
      platforms = r.platforms.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return {
      id: r.id,
      title: r.title,
      platforms,
      releaseDate: r.release_date,
      launchMsrpUsd: r.target_retail_price_usd,
      steamAppId: r.steam_app_id,
      steamHeaderImageUrl: r.steam_header_image_url,
    };
  });

  cache = { at: Date.now(), rows: out };
  return out;
}

export function getTitle(id: number): PartnershipsTitle | undefined {
  return listTitles().find((t) => t.id === id);
}

export function invalidateTitleCache(): void {
  cache = null;
}
