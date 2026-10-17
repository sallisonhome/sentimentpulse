import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated scratch DB per the SAFE pattern (see portal-actuals.test.ts):
// chdir BEFORE any dynamic `await import(...)` of ./storage; one DB test
// per file (each test file runs in its own node:test child process, and a
// second storage-importing test in the same file would reuse the closed
// cached Database instance -- the failure that motivated this file).

// Collector behavior (2026-10-17): identity validation, licenses-required-
// for-success, non-destructive snapshots, and never promoting licenses
// into download-estimate tables. The portal fetch is mocked at
// globalThis.fetch with fixtures shaped like the LIVE page observed
// against appid 5184670 on 2026-10-17 (tooltip prose row -- see
// steamworks-portal-demos.test.ts).
const portalPage = (reportAppId: number | null, licenses: number | null) => `
  ${reportAppId == null ? "<h1>Game: Mystery Report</h1>" : `<h1>Game: Clive Barker's Hellraiser: Revival Demo (${reportAppId})</h1>`}
  <table>
    <tr>
      <td>Lifetime free licenses <a href="#" class="tooltip">(?)<span>A free license is a grant of a product to a user, but does not necessarily mean the user has downloaded the product.</span></a></td>
      ${licenses == null ? "" : `<td align=right>${licenses.toLocaleString("en-US")}</td>`}
    </tr>
    <tr><td>Lifetime unique users</td><td align=right>312,353</td></tr>
  </table>
  <div>Clive Barker's Hellraiser: Revival Demo units sold, 1 day ( view as .csv )</div>
  <table>
    <tr><th>Complimentary units</th><th>1,004</th></tr>
  </table>`;

test("runDemosPortalCollector: stores licenses snapshots, requires identity + parsed licenses for success, never writes download actuals", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-portal-collector-"));
  process.chdir(dir);
  let db: any;
  const realFetch = globalThis.fetch;
  try {
    const { rawSqlite } = await import("../../storage");
    db = rawSqlite;
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO demo_titles (steam_app_id, name, is_saber_published, discovered_via, is_active, first_seen_at, created_at, updated_at)
       VALUES ('5184670', 'Clive Barker''s Hellraiser: Revival Demo', 1, 'saber_own', 1, ?, ?, ?)`
    ).run(nowIso, nowIso, nowIso);
    db.prepare(
      `INSERT INTO steamworks_sessions (id, cookie_value, created_at, updated_at) VALUES ('default', 'fixture-cookie', ?, ?)`
    ).run(nowIso, nowIso);
    const demoId = db.prepare(`SELECT id FROM demo_titles WHERE steam_app_id = '5184670'`).get().id as number;

    const { runDemosPortalCollector } = await import("./portal-actuals");

    // 1. Happy path: matching report identity + parsed licenses.
    globalThis.fetch = async () => new Response(portalPage(5184670, 493430), { status: 200 });
    let result = await runDemosPortalCollector();
    assert.equal(result.status, "success");
    assert.equal(result.dataPointsAdded, 1);
    let row = db.prepare(
      `SELECT lifetime_free_licenses, complimentary_units_period, lifetime_unique_users, updated_at FROM demo_portal_daily WHERE demo_title_id = ?`
    ).get(demoId) as any;
    assert.equal(row.lifetime_free_licenses, 493430);
    assert.equal(row.complimentary_units_period, 1004);
    assert.equal(row.lifetime_unique_users, 312353);
    const goodTimestamp = row.updated_at;

    // 2. Same target date, licenses now unparseable: the last successful
    //    value AND its observation timestamp must survive (a failed
    //    refresh must never erase the good snapshot), and the run is an
    //    error, not a collected data point.
    await new Promise(r => setTimeout(r, 5)); // distinct updated_at on success path
    globalThis.fetch = async () => new Response(portalPage(5184670, null), { status: 200 });
    result = await runDemosPortalCollector();
    assert.equal(result.status, "error", "null licenses must not count as success");
    assert.equal(result.dataPointsAdded, 0);
    assert.ok(/free licenses not parsed/i.test(result.message), result.message);
    row = db.prepare(
      `SELECT lifetime_free_licenses, updated_at FROM demo_portal_daily WHERE demo_title_id = ?`
    ).get(demoId) as any;
    assert.equal(row.lifetime_free_licenses, 493430, "last successful licenses value must be preserved");
    assert.equal(row.updated_at, goodTimestamp, "last successful observation timestamp must be preserved");

    // 3. Missing report identity (no Game header app id): rejected.
    globalThis.fetch = async () => new Response(portalPage(null, 493430), { status: 200 });
    result = await runDemosPortalCollector();
    assert.equal(result.status, "error");
    assert.equal(result.dataPointsAdded, 0);
    assert.ok(/identity missing/i.test(result.message), result.message);

    // 4. Identity mismatch: report page says a different app id.
    globalThis.fetch = async () => new Response(portalPage(9999999, 493430), { status: 200 });
    result = await runDemosPortalCollector();
    assert.equal(result.status, "error", "identity mismatch must be an error");
    assert.equal(result.dataPointsAdded, 0);
    assert.ok(/identity mismatch/i.test(result.message), result.message);

    // 5. Licenses never become download actuals / estimates.
    assert.equal(
      db.prepare(`SELECT COUNT(*) n FROM demo_window_estimates_daily WHERE method='steamworks_actual'`).get().n,
      0,
      "collector must never promote licenses into download-semantics tables"
    );
  } finally {
    globalThis.fetch = realFetch;
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
