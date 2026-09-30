import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Two identical Steam titles missing 2026-09-21. The unanchored one gets its published change
// split across the missing day from its own dated rating snapshots. The twin with a revenue
// calibration anchor (actual or publicly reported sales) must be byte-identical to the strict output.
test("route: gap allocation fills a missing day for unanchored titles and never touches anchored ones", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "gap-alloc-routes-"));
  process.chdir(dir);
  let server: any, db: any;
  const fetchOriginal = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    const ratings: Record<string, number> = { "2026-09-20": 100, "2026-09-21": 150, "2026-09-22": 300, "2026-09-23": 400 };
    for (const id of [49991, 49992]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'steam',?,'base','paid',6000,?,?)`).run(id, String(id), stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2020-01-01','2020-01-01',?,?)`).run(id, `Gap Route ${id}`, `Gap Route ${id}`, stamp, stamp);
      for (const [day, n] of Object.entries(ratings)) {
        db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
          VALUES(?,'steam',?,'qa',?,'ltd',?)`).run(id, day, n, stamp);
      }
      for (const [day, units] of [["2026-09-20", 1000], ["2026-09-22", 3000], ["2026-09-23", 4000]] as const) {
        db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
          VALUES(?,'steam','ltd',?,?,?,'review:ltd_state:accumulator',?)`).run(id, day, units, ratings[day], stamp);
      }
    }
    db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
      VALUES(49992,'steam','ltd','2026-09-23',158400,4000,6000,'full','steam_sales_daily',?)`).run(stamp);
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => {
      const r = await fetchOriginal(`http://127.0.0.1:${server.address().port}${path}`);
      const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); return body as any;
    };
    const q = "?from=2026-09-20&to=2026-09-23";
    const plain = await get(`/api/console/titles/49991/revenue-daily${q}`);
    const anchored = await get(`/api/console/titles/49992/revenue-daily${q}`);
        const at = (b: any, d: string) => b.points.find((p: any) => p.date === d);
    // Unchanged day is identical either way.
    assert.equal(at(plain, "2026-09-23").steam, 39600);
    assert.equal(at(anchored, "2026-09-23").steam, 39600);
    // Unanchored: 2,000 units of published change split 150-100=50 / 300-150=150 across Sep 21/22.
    assert.equal(Math.round(at(plain, "2026-09-21").steam), Math.round(500 * 39.6));
    assert.equal(Math.round(at(plain, "2026-09-22").steam), Math.round(1500 * 39.6));
    assert.deepEqual(at(plain, "2026-09-22").allocation, { steam: "gap:own_ratings" });
    // Anchored: strict behavior, nothing allocated.
    assert.equal(at(anchored, "2026-09-21").steam, null);
    assert.equal(at(anchored, "2026-09-22").steam, null);
    assert.equal(at(anchored, "2026-09-22").allocation, undefined);
    // Kill switch restores the strict output for everyone.
    db.prepare(`INSERT INTO app_settings(key,value,label,category,created_at,updated_at)
      VALUES('daily_gap_allocation_enabled','0','gap allocation','general',?,?)`).run(stamp, stamp);
    const off = await get(`/api/console/titles/49991/revenue-daily${q}`);
    assert.equal(at(off, "2026-09-21").steam, null);
    assert.equal(at(off, "2026-09-22").steam, null);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
