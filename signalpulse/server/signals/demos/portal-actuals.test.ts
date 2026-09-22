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
test("computeDemoWindowActuals: sums period rows per window, uses latest snapshot for ltd, never writes without coverage", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-portal-actuals-"));
  process.chdir(dir);
  let db: any;
  try {
    const { rawSqlite } = await import("../../storage");
    db = rawSqlite;
    const nowIso = new Date().toISOString();

    // Seed one Saber demo + one non-Saber demo (must be ignored entirely).
    db.prepare(
      `INSERT INTO demo_titles (steam_app_id, name, is_saber_published, discovered_via, is_active, first_seen_at, created_at, updated_at)
       VALUES ('5184670', 'Hellraiser Revival Demo', 1, 'saber_own', 1, ?, ?, ?)`
    ).run(nowIso, nowIso, nowIso);
    db.prepare(
      `INSERT INTO demo_titles (steam_app_id, name, is_saber_published, discovered_via, is_active, first_seen_at, created_at, updated_at)
       VALUES ('999999', 'Some Third Party Demo', 0, 'steam_demos_hub', 1, ?, ?, ?)`
    ).run(nowIso, nowIso, nowIso);
    const demoId = db.prepare(`SELECT id FROM demo_titles WHERE steam_app_id = '5184670'`).get().id as number;

    const today = new Date();
    const dateNDaysAgo = (n: number) => new Date(today.getTime() - n * 86400_000).toISOString().slice(0, 10);

    // 3 days of coverage inside the d7 window, one lifetime snapshot on
    // the most recent day. complimentary_units_period: 100, 150, 200 =>
    // d7 sum should be 450. lifetime_free_licenses only set on the last
    // (most recent) row = 9000, an EARLIER row has a smaller stale value
    // (500) that must NOT be summed or picked over the latest one.
    const rows: Array<[string, number | null, number | null]> = [
      [dateNDaysAgo(2), 100, 500],
      [dateNDaysAgo(1), 150, null],
      [dateNDaysAgo(0), 200, 9000],
    ];
    for (const [date, comp, lifetime] of rows) {
      db.prepare(
        `INSERT INTO demo_portal_daily (demo_title_id, date, complimentary_units_period, lifetime_free_licenses, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'portal_fetch', ?, ?)`
      ).run(demoId, date, comp, lifetime, nowIso, nowIso);
    }

    const { computeDemoWindowActuals } = await import("./portal-actuals");
    const result = computeDemoWindowActuals();

    assert.equal(result.demosWithActuals, 1, "only the Saber demo should get actuals rows");

    const d7 = db.prepare(
      `SELECT units_mid, method FROM demo_window_estimates_daily WHERE demo_title_id = ? AND window = 'd7'`
    ).get(demoId) as { units_mid: number; method: string };
    assert.equal(d7.units_mid, 450, "d7 must sum all 3 in-window rows (100+150+200)");
    assert.equal(d7.method, "steamworks_actual");

    const ltd = db.prepare(
      `SELECT units_mid, method FROM demo_window_estimates_daily WHERE demo_title_id = ? AND window = 'ltd'`
    ).get(demoId) as { units_mid: number; method: string };
    assert.equal(ltd.units_mid, 9000, "ltd must use the MOST RECENT lifetime snapshot, not a sum, and not a stale earlier value");
    assert.equal(ltd.method, "steamworks_actual");

    // Third-party demo must have zero rows written at all.
    const thirdPartyId = db.prepare(`SELECT id FROM demo_titles WHERE steam_app_id = '999999'`).get().id;
    const thirdPartyRows = db.prepare(
      `SELECT COUNT(*) as n FROM demo_window_estimates_daily WHERE demo_title_id = ?`
    ).get(thirdPartyId) as { n: number };
    assert.equal(thirdPartyRows.n, 0, "non-Saber demos must never get a steamworks_actual row");

    // A window with zero coverage (m12, no rows old enough / no data at
    // all beyond the 3 seeded days -- but they ARE within m12 too, so
    // instead verify a demo with NO portal rows at all writes nothing.
    db.prepare(
      `INSERT INTO demo_titles (steam_app_id, name, is_saber_published, discovered_via, is_active, first_seen_at, created_at, updated_at)
       VALUES ('7777777', 'Docked Demo', 1, 'saber_own', 1, ?, ?, ?)`
    ).run(nowIso, nowIso, nowIso);
    const dockedId = db.prepare(`SELECT id FROM demo_titles WHERE steam_app_id = '7777777'`).get().id;
    computeDemoWindowActuals();
    const dockedRows = db.prepare(
      `SELECT COUNT(*) as n FROM demo_window_estimates_daily WHERE demo_title_id = ?`
    ).get(dockedId) as { n: number };
    assert.equal(dockedRows.n, 0, "a Saber demo with zero demo_portal_daily rows must get no actuals rows (falls back to multiplier estimate)");
  } finally {
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

