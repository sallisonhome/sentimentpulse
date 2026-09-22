import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated scratch DB per the SAFE pattern (console-family-routes.test.ts):
// process.chdir() BEFORE any dynamic `await import(...)` of ./storage --
// storage.ts's `new Database("data.db")` resolves against process.cwd() at
// module-evaluation time, and a *static* top-level import is hoisted above
// any chdir in the same file (this is exactly the bug that corrupted the
// real dev data.db earlier in this project -- see lessons.md). Dynamic
// `await import()` is a genuine runtime expression, not hoisted, so
// chdir-then-dynamic-import is safe. Never add a static
// `import ... from "./storage"` (or anything that transitively imports it)
// to this file.
test("computeDemoWindowActuals: never downgrades an existing steamworks_actual row when re-run with the same data, and estimator upsert cannot clobber it", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-portal-actuals-guard-"));
  process.chdir(dir);
  let db: any;
  try {
    const { rawSqlite } = await import("../../storage");
    db = rawSqlite;
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO demo_titles (steam_app_id, name, is_saber_published, discovered_via, is_active, first_seen_at, created_at, updated_at)
       VALUES ('5184670', 'Hellraiser Revival Demo', 1, 'saber_own', 1, ?, ?, ?)`
    ).run(nowIso, nowIso, nowIso);
    const demoId = db.prepare(`SELECT id FROM demo_titles WHERE steam_app_id = '5184670'`).get().id as number;
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO demo_portal_daily (demo_title_id, date, complimentary_units_period, lifetime_free_licenses, source, created_at, updated_at)
       VALUES (?, ?, 500, 12000, 'portal_fetch', ?, ?)`
    ).run(demoId, today, nowIso, nowIso);

    // Also seed review history so the multiplier estimator has something
    // to compute for the same demo -- this reproduces the real ordering
    // ambiguity between the two writers.
    db.prepare(
      `INSERT INTO steam_review_history (app_id, bucket_start, bucket_granularity, recommendations_up, recommendations_down, source_endpoint, created_at)
       VALUES ('5184670', ?, 'day', 10, 2, 'test', ?)`
    ).run(Math.floor(Date.now() / 1000) - 3600, nowIso);

    const { computeDemoWindowActuals } = await import("./portal-actuals");
    const { computeDemoWindowEstimates } = await import("./estimator");

    // Actuals first, then estimator -- estimator's own WHERE guard must
    // prevent it from downgrading the just-written steamworks_actual row.
    computeDemoWindowActuals();
    computeDemoWindowEstimates();

    const d7 = db.prepare(
      `SELECT units_mid, method FROM demo_window_estimates_daily WHERE demo_title_id = ? AND window = 'd7'`
    ).get(demoId) as { units_mid: number; method: string };
    assert.equal(d7.method, "steamworks_actual", "estimator must not clobber an actual row that already exists for the same day");
    assert.equal(d7.units_mid, 500);
  } finally {
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
