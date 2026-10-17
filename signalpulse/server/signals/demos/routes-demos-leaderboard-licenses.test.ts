import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated scratch DB per the SAFE pattern (see portal-actuals.test.ts):
// chdir BEFORE any dynamic `await import(...)` of ./storage; one DB test
// per file.

// Licenses-column invariants (2026-10-17): Free licenses (LTD) is a
// display-only metric. It must never change download ranking, and it must
// stay the same LTD value regardless of the selected download window.
test("leaderboard: free licenses never affect download ranking and stay LTD across windows", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-leaderboard-licenses-"));
  process.chdir(dir);
  let db: any;
  let server: any;
  const realFetch = globalThis.fetch;
  try {
    db = (await import("../../storage")).rawSqlite;
    const { default: express } = await import("express");
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    const app = express();
    registerDemosLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    const today = new Date().toISOString().slice(0, 10);
    const stamp = new Date().toISOString();

    // Demo 1 (Saber): FEWER downloads (200) but MORE licenses (9000).
    // Demo 2 (Saber): more downloads (500), fewer licenses (1000).
    // Demo 3 (non-Saber): estimate 100, no licenses (no Steamworks view).
    for (const [id, saber] of [[1, 1], [2, 1], [3, 0]] as const) {
      db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
        VALUES(?,?,?,'Casual',?,'test',1,?,?,?)`).run(id, String(1000 + id), `Demo ${id}`, today, today, today, today);
      if (saber) db.prepare("UPDATE demo_titles SET is_saber_published=1 WHERE id=?").run(id);
    }
    for (const [window, d1, d2] of [["d7", 200, 500], ["ltd", 200, 500]] as const) {
      for (const [appId, downloads] of [["1001", d1], ["1002", d2]] as const) {
        db.prepare(
          `INSERT INTO demo_download_actuals(steam_app_id,window,downloads,report_start_date,report_end_date,fetched_at,source,last_attempt_at)
           VALUES(?,?,?,?,?,?,'steamworks_downloads_report',?)`
        ).run(appId, window, downloads, "2000-01-01", today, stamp, stamp);
      }
    }
    for (const [appId, licenses] of [[1001, 9000], [1002, 1000]] as const) {
      const demoId = db.prepare("SELECT id FROM demo_titles WHERE steam_app_id=?").get(String(appId)).id;
      db.prepare(
        `INSERT INTO demo_portal_daily(demo_title_id,date,lifetime_free_licenses,source,created_at,updated_at)
         VALUES(?,?,?,'portal_fetch',?,?)`
      ).run(demoId, today, licenses, stamp, stamp);
    }
    // Non-Saber demo 3 gets a review-based estimate of 100.
    for (const window of ["d7", "ltd"]) {
      db.prepare(
        `INSERT INTO demo_window_estimates_daily(demo_title_id,window,as_of_date,units_mid,review_delta,units_low,units_high,method,created_at)
         VALUES(3,?,?,100,1,30,100,'review_delta_multiplier',?)`
      ).run(window, today, stamp);
    }

    // 1. Download ranking is unchanged by licenses: 500 > 200 > 100.
    for (const window of ["d7", "ltd"]) {
      const data = await (await realFetch(`${url}?window=${window}&sort=downloads&direction=desc&limit=10`)).json();
      assert.deepEqual(data.demos.map((d: any) => d.id), [2, 1, 3],
        `downloads ranking must be unaffected by licenses (${window})`);
    }

    // 2. Licenses surface for Saber demos only, same LTD value in every window.
    for (const window of ["d7", "d30", "ltd"]) {
      const data = await (await realFetch(`${url}?window=${window}&limit=10`)).json();
      const byId = new Map(data.demos.map((d: any) => [d.id, d]));
      assert.equal(byId.get(1).freeLicensesLtd, 9000);
      assert.equal(byId.get(2).freeLicensesLtd, 1000);
      assert.equal(byId.get(1).licensesAsOf, stamp);
      assert.equal(byId.get(3).freeLicensesLtd, null, "non-Saber demos never get licenses");
      assert.equal(byId.get(3).licensesAsOf, null);
    }

    // 3. A Saber demo with no licenses snapshot shows null, never zero.
    db.prepare("DELETE FROM demo_portal_daily WHERE demo_title_id=1").run();
    const data = await (await realFetch(`${url}?window=d7&limit=10`)).json();
    const row = data.demos.find((d: any) => d.id === 1);
    assert.equal(row.freeLicensesLtd, null, "no snapshot must be null, never zero");
    assert.equal(row.licensesStale, true);
  } finally {
    if (server) await new Promise<void>(r => server.close(() => r()));
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
