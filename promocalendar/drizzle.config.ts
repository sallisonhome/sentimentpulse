import { defineConfig } from "drizzle-kit";

// SQLite, colocated with the server as ./data.db, matches SignalPulse's
// pattern. In production the working directory is
// /opt/sentimentpulse/partnerships so the absolute path is
// /opt/sentimentpulse/partnerships/data.db.
export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.PARTNERSHIPS_DB_URL || "./data.db",
  },
});
