// OFFLINE QA ONLY. Run with cwd an empty, isolated directory, never application cwd.
import { existsSync } from "node:fs";
if (existsSync("data.db")) throw new Error("Refusing existing database");
const { rawSqlite } = await import("../server/storage");
const { ensureDailyMixSchema } = await import("../server/revenue-mix-daily");
ensureDailyMixSchema(rawSqlite);
rawSqlite.close();
console.log("Empty current-schema offline fixture ready");
