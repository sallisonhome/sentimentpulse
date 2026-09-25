/**
 * DRY RUN is the default and opens SQLite read-only, without storage migrations.
 * Apply requires the exact reviewed manifest SHA and an online SQLite backup.
 * Estimator deployment/refresh is a separate, approved operation.
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { planSteamLtdRepair, applySteamLtdRepair, rollbackSteamLtdRepair } from "../server/steam-ltd-overlap-repair";

const args = process.argv.slice(2);
const value = (key: string) => args[args.indexOf(key) + 1];
const apply = args.includes("--apply"), rollback = args.includes("--rollback");
if (apply && rollback) throw new Error("Choose apply or rollback, not both");
const dbPath = resolve(process.env.DB_PATH ?? "data.db");
const asOfDate = process.env.AS_OF ?? new Date().toISOString().slice(0, 10);
const db = new Database(dbPath, { readonly: !apply && !rollback, fileMustExist: true });
db.pragma("busy_timeout=10000");
try {
  const plan = planSteamLtdRepair(db, asOfDate);
  if (!apply && !rollback) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    if (!args.includes("--confirm") || value("--confirm") !== "CONFIRM") throw new Error("Explicit --confirm CONFIRM required");
    if (apply && (!args.includes("--expected-sha") || value("--expected-sha") !== plan.sha256)) {
      throw new Error("Exact --expected-sha from a fresh reviewed dry-run is required");
    }
    if (rollback && (!args.includes("--run-id") || !value("--run-id"))) throw new Error("--run-id required");
    const dir = resolve(process.env.BACKUP_DIR ?? "repair-backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(dir, `steam-overlap-${runId}.db`);
    if (existsSync(backup)) throw new Error("Backup already exists");
    await db.backup(backup);
    const result = rollback ? rollbackSteamLtdRepair(db, value("--run-id")) : applySteamLtdRepair(db, plan, runId);
    console.log(JSON.stringify({ ...result, backup, planSha256: plan.sha256 }));
  }
} finally { db.close(); }
