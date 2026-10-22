import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated scratch DB per the SAFE pattern (see portal-actuals.test.ts):
// chdir BEFORE any dynamic `await import(...)` of ./storage; one DB test
// per file.

// Peak CCU presentation (2026-10-22): the dash's peak column must show
// Steam's own charts peak for tracked appids that chart in the most-played
// top 100 (fresh within 24h), fall back to the max of our samples from the
// last 24h otherwise, and never present a stale (>24h) Steam peak. The
// all-time observed peak stays available separately for the detail page.
test("leaderboard: peak CCU column prefers Steam's charts peak, falls back to observed 24h max", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-leaderboard-ccu-"));
  process.chdir(dir);
  let db: any;
  let server: any;
  try {
    db = (await import("../../storage")).rawSqlite;
    const { default: express } = await import("express");
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    const app = express();
    registerDemosLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    const now = new Date();
    const iso = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
    const stamp = now.toISOString();

    // 1001: fresh Steam peak (500) + recent samples (max 100) -> Steam wins.
    // 1002: no Steam peak; recent samples max 70 -> observed 70.
    // 1003: STALE Steam peak (2 days old) -> ignored, observed 30 wins.
    // 1004: no samples, no Steam peak -> nulls.
    for (const [id, appId] of [[1, "1001"], [2, "1002"], [3, "1003"], [4, "1004"]] as const) {
      db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
        VALUES(?,?,?,'Simulation',?,'test',1,?,?,?)`).run(id, appId, `Demo ${id}`, stamp.slice(0, 10), stamp, stamp, stamp);
    }
    const snapshot = (appId: string, offsetMs: number, ccu: number) => {
      const demoId = db.prepare("SELECT id FROM demo_titles WHERE steam_app_id=?").get(appId).id;
      db.prepare("INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES (?,?,?)").run(demoId, iso(offsetMs), ccu);
    };
    snapshot("1001", 40 * 60_000, 50);   // latest sample 40m ago
    snapshot("1001", 2 * 60 * 60_000, 100); // earlier sample, higher
    snapshot("1002", 30 * 60_000, 70);
    snapshot("1003", 30 * 60_000, 30);
    db.prepare(`INSERT INTO demo_ccu_steam_peaks(steam_app_id,global_rank,current_ccu,peak_ccu,captured_at)
      VALUES('1001',5,480,500,?)`).run(iso(20 * 60_000));
    db.prepare(`INSERT INTO demo_ccu_steam_peaks(steam_app_id,global_rank,current_ccu,peak_ccu,captured_at)
      VALUES('1003',9,25,900,?)`).run(iso(2 * 24 * 60 * 60_000)); // stale -> ignored

    const data = await (await fetch(`${url}?sort=peak&direction=desc&limit=10`)).json();
    const byId = new Map(data.demos.map((d: any) => [d.id, d]));
    const one = byId.get(1), two = byId.get(2), three = byId.get(3), four = byId.get(4);
    assert.equal(one.ccuRecentPeak, 500, "fresh Steam peak wins over observed samples");
    assert.equal(one.ccuRecentPeakSource, "steam");
    assert.equal(one.ccuSteamRank, 5);
    assert.equal(one.ccuCurrent, 50, "current column shows the LATEST sample, not the max");
    assert.equal(one.ccuAsOf, iso(40 * 60_000));
    assert.equal(two.ccuRecentPeak, 70, "no Steam peak -> observed 24h max");
    assert.equal(two.ccuRecentPeakSource, "observed");
    assert.equal(three.ccuRecentPeak, 30, "stale Steam peak (>24h) must be ignored");
    assert.equal(three.ccuRecentPeakSource, "observed");
    assert.equal(four.ccuRecentPeak, null);
    assert.equal(four.ccuRecentPeakSource, null);

    // sort=peak ranks by the presented peak: 500 > 70 > 30 > null.
    assert.deepEqual(data.demos.map((d: any) => d.id), [1, 2, 3, 4], "peak sort uses the presented 24h peak");

    // All-time observed peak stays available (separate from the 24h column).
    const demo2Id = db.prepare("SELECT id FROM demo_titles WHERE steam_app_id='1002'").get().id;
    db.prepare(`INSERT INTO demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu,created_at) VALUES (?, '2020-01-01', 5000, ?)`)
      .run(demo2Id, stamp);
    const data2 = await (await fetch(`${url}?limit=10`)).json();
    const two2 = data2.demos.find((d: any) => d.id === 2);
    assert.equal(two2.ccuAllTimePeak, 5000, "all-time observed peak preserved for the detail page");
    assert.equal(two2.ccuRecentPeak, 70, "24h column unaffected by an ancient daily peak");
  } finally {
    if (server) await new Promise<void>(resolve => server.close(resolve));
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
