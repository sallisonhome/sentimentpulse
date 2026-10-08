import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Guards: a ratio step with no earlier valued day, or dated before the rule's start, keeps the legacy value so no sales are dropped.
test("route: unscoped-by-guard steps keep the legacy value", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "ratio-step-guards-"));
  process.chdir(dir);
  let server: any, db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString(), M = "calibrated_from_actuals_v1+steam_histogram_nonoverlap_v1";
    const cases: Array<[number, string, Record<string, number>, Record<string, number>]> = [
      [49991, "Halloween: The Game", { "2026-10-02": 1000, "2026-10-03": 1100, "2026-10-04": 1200 }, { "2026-10-02": 20000, "2026-10-03": 33000, "2026-10-04": 36600 }],
      [49992, "Control Resonant", { "2026-09-22": 1000, "2026-09-23": 1100, "2026-09-24": 1200, "2026-09-25": 1300, "2026-09-26": 1400 },
        { "2026-09-22": 20000, "2026-09-23": 22000, "2026-09-24": 24000, "2026-09-25": 26000, "2026-09-26": 42000 }],
    ];
    for (const [id, name, ratings, ltd] of cases) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,'steam',?,'base','paid',6000,?,?)`).run(id, String(id), stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,'2020-01-01','2020-01-01',?,?)`).run(id, name, name, stamp, stamp);
      for (const [day, n] of Object.entries(ratings)) db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at) VALUES(?,'steam',?,'qa',?,'ltd',?)`).run(id, day, n, stamp);
      for (const [day, u] of Object.entries(ltd)) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at) VALUES(?,'steam','ltd',?,?,?,?,?)`).run(id, day, u, ratings[day], M, stamp);
    }
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json() as Promise<any>;
    const unit = 60 * 0.66;
    const a = await get("/api/console/titles/49991/revenue-daily?from=2026-10-02&to=2026-10-04");
    assert.equal(Math.round(a.points.find((p: any) => p.date === "2026-10-03").steam), Math.round(13000 * unit));
    const b = await get("/api/console/titles/49992/revenue-daily?from=2026-09-23&to=2026-09-26");
    assert.equal(Math.round(b.points.find((p: any) => p.date === "2026-09-26").steam), Math.round(16000 * unit));
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
