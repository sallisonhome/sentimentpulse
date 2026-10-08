import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Scoped family vs identical twin: launch week D1-D9 (2026-09-08..16) is re-timed by next-day Steam reviews, total conserved.
test("route: launch week reshaped by next-day reviews for the scoped family only", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "launch-week-"));
  process.chdir(dir);
  let server: any, db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString(), M = "calibrated_from_actuals_v1+steam_histogram_nonoverlap_v1";
    const ratings: Record<string, number> = {}, ltd: Record<string, number> = {};
    const rdays = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];
    const rc = [2000, 9000, 9500, 9900, 10200, 10400];
    rdays.forEach((d, i) => { ratings[d] = rc[i]; ltd[d] = rc[i] * 20; });
    // Steam daily reviews D1..D10 (Sep 8..17); next-day weights apply to D1..D9.
    const rev = [900, 800, 700, 600, 500, 400, 300, 250, 200, 150];
    const ids: Array<[number, string, string]> = [[49971, "Halloween: The Game", "app49971"], [49972, "Launch Twin Title", "app49972"]];
    for (const [id, name, app] of ids) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,'steam',?,'base','paid',6000,?,?)`).run(id, app, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,'2026-09-08','2026-09-08',?,?)`).run(id, name, name, stamp, stamp);
      for (const [day, n] of Object.entries(ratings)) db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at) VALUES(?,'steam',?,'qa',?,'ltd',?)`).run(id, day, n, stamp);
      for (const [day, u] of Object.entries(ltd)) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at) VALUES(?,'steam','ltd',?,?,?,?,?)`).run(id, day, u, ratings[day], M, stamp);
      rev.forEach((n, i) => db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down,source_endpoint,created_at) VALUES(?,?,'day',?,0,'qa','2026-10-08')`)
        .run(app, Date.parse("2026-09-08T00:00:00Z") / 1000 + i * 86400, n));
    }
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json() as Promise<any>;
    const q = "?from=2026-09-08&to=2026-09-19";
    const s = await get(`/api/console/titles/49971/revenue-daily${q}`), t = await get(`/api/console/titles/49972/revenue-daily${q}`);
    const v = (b: any, d: string) => (b.points.find((p: any) => p.date === d)?.steam ?? null) as number | null;
    const lw = ["08", "09", "10", "11", "12", "13", "14", "15", "16"].map(x => `2026-09-${x}`);
    const sum = (b: any) => lw.reduce((a, d) => a + (v(b, d) ?? 0), 0);
    assert.ok(sum(t) > 0);
    assert.ok(Math.abs(sum(s) - sum(t)) < 1, `${sum(s)} vs ${sum(t)}`);
    // shares follow next-day reviews: D1 weight = rev[1]=800 ... D9 weight = rev[9]=150
    const w = rev.slice(1), wsum = w.reduce((a, x) => a + x, 0);
    lw.forEach((d, i) => assert.ok(Math.abs((v(s, d) as number) - sum(t) * w[i] / wsum) < 1, d));
    assert.equal(v(s, "2026-09-17"), v(t, "2026-09-17"));
    assert.equal(v(s, "2026-09-18"), v(t, "2026-09-18"));
    assert.equal(s.points.find((p: any) => p.date === "2026-09-10").allocation?.steam, "launch_week:steam_review_activity");
    assert.equal(t.points.find((p: any) => p.date === "2026-09-10").steam, null);
    // query ending before D9 does not apply the rule
    const early = await get("/api/console/titles/49971/revenue-daily?from=2026-09-08&to=2026-09-15");
    assert.equal(early.points.find((p: any) => p.date === "2026-09-10").steam, null);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
