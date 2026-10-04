import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Real route, real SQLite schema, seeded 60-title Xbox chart: report mode must not change a number,
// enforce must move only the contradicting non-anchored rows, and the DB must never be written.
test("leaderboard route: chart consistency report/enforce/off", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "chart-cons-"));
  process.chdir(dir);
  let db: any, server: any; const env = process.env.CHART_CONSISTENCY_MODE;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString().slice(0, 10);
    const N = 60, OFF = 61;
    const units = (i: number) => Math.round(100000 * Math.pow(i, -0.8));
    const seed = (id: number, name: string, d7: number, d30: number, ranked: boolean) => {
      const sku = `9N${String(id).padStart(10, "0")}`;
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,?,?,'base','paid',2999,?,?)`).run(id, "xbox", sku, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,'2025-01-01','2025-01-01',?,?)`).run(id, name, name, stamp, stamp);
      db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,?,?,?,?,1)").run(sku, name, null, "displaycatalog", stamp, stamp);
      for (const [w, u] of [["d7", d7], ["d30", d30], ["d90", d30 * 2], ["m12", d30 * 8], ["ltd", d30 * 8]] as const)
        db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,signal_value,method,created_at) VALUES(?,?,?,?,?,?,500,'fixture',?)`).run(id, "xbox", w, stamp, u, u, stamp);
      if (ranked) db.prepare(`INSERT INTO console_storefront_rank_daily VALUES('xbox','xbox_api_top_paid',?,?,?,?)`).run(stamp, id, id, stamp);
    };
    for (let i = 1; i <= N; i++) seed(i, `Title ${i}`, units(i), units(i) * 4, true);
    // contradictions: #30 over-estimated 8x, #45 under-estimated 10x, anchored #20 inflated 30x, overridden #25 inflated 30x
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid*8, owners_mid=owners_mid*8 WHERE title_id=30 AND window IN ('d7','d30')").run();
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid/10, owners_mid=owners_mid/10 WHERE title_id=45 AND window IN ('d7','d30')").run();
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid*30, owners_mid=owners_mid*30 WHERE title_id IN (20,25) AND window IN ('d7','d30')").run();
    db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at) VALUES(20,'xbox','d30',?,?,?,2999,'regular','manual_anchor_verified_ltd',?)`).run(stamp, 90000 * 29.99 * 30 / 30, 90000, stamp);
    db.prepare(`INSERT INTO title_multiplier_overrides(title_id,platform,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at) VALUES(25,'xbox',50,.5,.9,'low','fixture',?,?)`).run(stamp, stamp);
    seed(OFF, "Off Chart Huge", 900000, 900000 * 4, false);
    seed(OFF + 1, "Off Chart Small", 40, 160, false);
    seed(OFF + 2, "Missed Today Huge", 900000, 900000 * 4, false);   // charted yesterday only: an ID/one-day gap, never capped
    db.prepare(`INSERT INTO console_storefront_rank_daily VALUES('xbox','xbox_api_top_paid',?,?,?,?)`).run(new Date(Date.now() - 86400000).toISOString().slice(0, 10), OFF + 2, 3, stamp);

    // launch-week title: over-estimated 8x like Gears-style pre-order, must be shown but never cut
    db.prepare("UPDATE window_estimates_daily SET units_mid=units_mid*8, owners_mid=owners_mid*8 WHERE title_id=35 AND window IN ('d7','d30')").run();
    db.prepare("UPDATE console_title_igdb SET release_date=?, store_release_date=? WHERE title_id=35").run(stamp, stamp);
    const before = db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all();
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const get = async (mode: string | undefined, path: string) => {
      if (mode === undefined) delete process.env.CHART_CONSISTENCY_MODE; else process.env.CHART_CONSISTENCY_MODE = mode;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`); const body: any = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body)); return body;
    };
    const by = (b: any) => new Map<string, any>(b.titles.map((t: any) => [t.name, t]));
    for (const window of ["d30", "d7"]) {
      const p = `/api/console/leaderboards/xbox?window=${window}&limit=100`;
      const off = by(await get("off", p)), rep = by(await get(undefined, p)), enf = by(await get("enforce", p));
      assert.ok(off.size >= 61, `rows ${off.size}`);
      // report == off for every number; only the annotation differs
      for (const [name, t] of off) { assert.equal(rep.get(name).unitsMid, t.unitsMid, `report ${name}`); assert.equal(rep.get(name).revenueMidUsd, t.revenueMidUsd, `report rev ${name}`); }
      assert.ok(rep.get("Title 30").chartConsistency, "report annotates the contradiction"); assert.equal(rep.get("Title 30").chartConsistency.applied, false);
      assert.equal(off.get("Title 30").chartConsistency, undefined);
      // enforce: over-estimated lowered with revenue scaled in step, under-estimated raised (capped 3x)
      const o30 = off.get("Title 30"), e30 = enf.get("Title 30");
      assert.ok(e30.unitsMid < o30.unitsMid, `${window} over-estimate lowered`);
      assert.ok(Math.abs(e30.revenueMidUsd / e30.unitsMid - o30.revenueMidUsd / o30.unitsMid) < 0.01, "ASP preserved");
      assert.ok(e30.unitsMid < 3 * units(30) * (window === "d30" ? 4 : 1), "lands near the chart-consistent value");
      const o45 = off.get("Title 45"), e45 = enf.get("Title 45");
      assert.ok(e45.unitsMid > o45.unitsMid && e45.unitsMid <= 3 * o45.unitsMid + 1, `${window} under-estimate raised within cap`);
      // launch-week title: annotated, never moved
      assert.equal(enf.get("Title 35").unitsMid, off.get("Title 35").unitsMid, "launch-window title untouched");
      assert.equal(enf.get("Title 35").chartConsistency?.bound, "launch_window_protected");
      // anchored + overridden rows untouched
      assert.equal(enf.get("Title 20").unitsMid, off.get("Title 20").unitsMid, "anchored row untouched");
      assert.equal(enf.get("Title 25").unitsMid, off.get("Title 25").unitsMid, "overridden row untouched");
      // off-chart huge capped, small untouched
      assert.ok(enf.get("Off Chart Huge").unitsMid < off.get("Off Chart Huge").unitsMid / 5);
      assert.equal(enf.get("Off Chart Small").unitsMid, off.get("Off Chart Small").unitsMid);
      assert.equal(enf.get("Missed Today Huge").unitsMid, off.get("Missed Today Huge").unitsMid, "recently charted title never capped");
      // consistent rows (every title that was not seeded as a contradiction) are identical in all modes
      for (const i of [1, 2, 3, 10, 15, 40, 50, 59]) assert.equal(enf.get(`Title ${i}`).unitsMid, off.get(`Title ${i}`).unitsMid, `Title ${i} unchanged`);
    }
    // other windows are never touched
    const o90 = by(await get("off", "/api/console/leaderboards/xbox?window=d90&limit=100")), e90 = by(await get("enforce", "/api/console/leaderboards/xbox?window=d90&limit=100"));
    for (const [n, t] of o90) assert.equal(e90.get(n).unitsMid, t.unitsMid, `d90 ${n}`);
    // steam is never touched even with enforce
    assert.equal((await get("enforce", "/api/console/leaderboards/steam?window=d30&limit=100")).count, 0);
    // the route never writes
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(), before);
  } finally {
    if (env === undefined) delete process.env.CHART_CONSISTENCY_MODE; else process.env.CHART_CONSISTENCY_MODE = env;
    if (server) await new Promise<void>(r => server.close(() => r()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
