import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// FC 27 (2026-10-06): a verified lifetime anchor 6.5x the estimator was ignored by every shorter window,
// so an 18-day-old title showed lifetime 506.7M next to a 30-day figure of 77.7M.
test("a young title's verified lifetime anchor governs every window it covers; shorter windows keep the estimator's time shape", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "young-anchor-"));
  process.chdir(dir);
  let db: any, server: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const stamp = day(0), young = day(-18), old = "2025-01-10";
    const ids = [[10201, "steam", "young-s", "Young Anchor Test", young], [10202, "ps5", "young-p", "Young Anchor Test", young],
      [10203, "steam", "old-s", "Old Anchor Test", old], [10204, "ps5", "old-p", "Old Anchor Test", old]] as const;
    for (const [id, platform, sku, name, rel] of ids) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',6999,?,?)`).run(id, platform, sku, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, name, name, rel, rel, stamp, stamp);
    }
    for (const id of [10201, 10202, 10203, 10204]) {
      const platform = ids.find(r => r[0] === id)![1];
      for (const [w, units] of [["d7", 7000], ["d30", 25000], ["d90", 25000], ["m12", 25000], ["ltd", 25000]] as const)
        db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,signal_value,method,created_at)
          VALUES(?,?,?,?,?,?,?,'fixture',?)`).run(id, platform, w, stamp, units, units, 500, stamp);
    }
    const anchor = (id: number, p: string, rev: number, units: number | null) =>
      db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,
        reference_msrp_usd_cents,sale_state,data_source,created_at) VALUES(?,?,'ltd',?,?,?,6999,'baseline','manual_anchor_verified_ltd',?)`)
        .run(id, p, stamp, rev, units, stamp);
    anchor(10201, "steam", 25544950, 553000); anchor(10202, "ps5", 506700000, null);
    anchor(10203, "steam", 25544950, 553000); anchor(10204, "ps5", 506700000, null);
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const row = async (platform: string, w: string, name: string) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/console/leaderboards/${platform}?window=${w}&limit=100`);
      const b: any = await r.json(); assert.equal(r.status, 200);
      return b.titles.find((t: any) => t.name === name);
    };
    for (const [platform, anchorRev] of [["ps5", 506700000], ["steam", 25544950]] as const) {
      for (const w of ["d30", "d90", "m12"]) {
        const t = await row(platform, w, "Young Anchor Test");
        assert.equal(Math.round(t.revenueMidUsd), anchorRev, `${platform} ${w}`);
        assert.equal(t.dataSource, "scaled_to_verified_ltd_anchor_full_life");
      }
      const d7 = await row(platform, "d7", "Young Anchor Test");
      assert.equal(d7.dataSource, "scaled_to_verified_ltd_anchor_young_share");
      assert.ok(Math.abs(d7.revenueMidUsd / anchorRev - 7000 / 25000) < 1e-6, `${platform} d7 share ${d7.revenueMidUsd / anchorRev}`);
      assert.ok(d7.revenueMidUsd <= (await row(platform, "d30", "Young Anchor Test")).revenueMidUsd);
    }
    const steam30 = await row("steam", "d30", "Young Anchor Test");
    assert.equal(steam30.unitsMid, 553000, "verified anchor units carry to the window");
    // An older title keeps the guard: an anchor above the estimator does not scale its windows.
    const oldPs5 = await row("ps5", "d30", "Old Anchor Test");
    assert.notEqual(oldPs5.dataSource, "scaled_to_verified_ltd_anchor_full_life");
    assert.ok(oldPs5.revenueMidUsd < 506700000);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
