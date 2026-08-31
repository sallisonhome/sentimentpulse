import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

/**
 * Shared Postgres client for the Partnerships app.
 *
 * Reads DATABASE_URL from the environment. In production this points at the
 * same droplet Postgres that SignalPulse and Trip Tracker use, so PR 3 can
 * read SignalPulse's product tables directly for the title projection.
 *
 * The pool is lazy so a missing DATABASE_URL in dev only errors when a route
 * actually needs the DB — the health check stays green.
 */
let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  _pool = new pg.Pool({ connectionString: url });
  return _pool;
}

export function getDb() {
  if (_db) return _db;
  _db = drizzle(getPool());
  return _db;
}
