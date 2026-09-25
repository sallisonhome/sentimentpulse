import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  planLifetimeCatalogRepair as planLifetimeSeedRepair,
  applyLifetimeCatalogRepair as applyLifetimeSeedRepair,
  rollbackLifetimeCatalogRepair as rollbackLifetimeSeedRepair,
} from "../server/lifetime-catalog-repair";

const args = process.argv.slice(2);
const value = (key: string) => args.includes(key) ? args[args.indexOf(key)+1] : undefined;
const apply = args.includes("--apply"), rollback = args.includes("--rollback");
if (apply && rollback) throw Error("Choose apply or rollback");
const db = new Database(resolve(process.env.DB_PATH ?? "data.db"), { readonly: !apply && !rollback, fileMustExist: true });
db.pragma("busy_timeout=10000");
try {
  if (rollback) {
    if (value("--confirm") !== "CONFIRM" || !value("--run-id")) throw Error("Confirmed run ID required");
    const dir = resolve(process.env.BACKUP_DIR ?? "repair-backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backup = join(dir, `pre-rollback-seed-${Date.now()}.db`);
    await db.backup(backup);
    console.log(JSON.stringify({ ...rollbackLifetimeSeedRepair(db, value("--run-id")!), backup }));
  } else {
    const plan = planLifetimeSeedRepair(db, process.env.AS_OF ?? new Date().toISOString().slice(0,10));
    if (value("--output")) writeFileSync(resolve(value("--output")!), JSON.stringify(plan,null,2), { mode: 0o600 });
    const summary = { version: plan.version, asOf: plan.asOf, sha256: plan.sha256,
      audited: plan.audit.stateCount, repairs: plan.entries.filter(e=>e.status==="repair") };
    if (!apply) console.log(JSON.stringify(summary,null,2));
    else {
      if (value("--confirm") !== "CONFIRM" || value("--expected-sha") !== plan.sha256) throw Error("Fresh reviewed manifest SHA and confirmation required");
      if (!summary.repairs.length) throw Error("No proven repairs");
      const runId = new Date().toISOString().replace(/[:.]/g,"-");
      const dir = resolve(process.env.BACKUP_DIR ?? "repair-backups");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backup = join(dir,`lifetime-seed-${runId}.db`);
      await db.backup(backup);
      console.log(JSON.stringify({ ...applyLifetimeSeedRepair(db, plan, runId), backup, planSha: plan.sha256 }));
    }
  }
} finally { db.close(); }
