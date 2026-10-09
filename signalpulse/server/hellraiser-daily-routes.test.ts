import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("route: Hellraiser daily series, Steam actuals from D1 and console estimates shaped by Steam", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "hellraiser-daily-"));
  process.chdir(dir);
  let server: any, db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const now = new Date().toISOString(), N = "Clive Barker's Hellraiser: Revival";
    db.prepare(`INSERT INTO products(id,title,platforms,player_format,genre,release_date,steam_app_id,created_at,updated_at) VALUES(7,?,'steam','single','horror','2026-10-08','1551980',?,?)`).run(N, now, now);
    const sales: Array<[string, number, number]> = [["2026-10-06", 100, 4000], ["2026-10-07", 200, 8000], ["2026-10-08", 700, 28000], ["2026-10-09", 300, 12000]];
    for (const [d, u, r] of sales) db.prepare(`INSERT INTO steam_sales_daily(product_id,date,sku_group,net_units,gross_units,net_revenue_usd,gross_revenue_usd,created_at,updated_at) VALUES(7,?,'base',?,?,?,?,?,?)`).run(d, u, u, r, r, now, now);
    const maps: Array<[number, string, string, string, number]> = [[10664, "steam", "1551980", "base", 3999], [11296, "ps5", "EP6853-PPSA25642_00-0082868685413873", "base", 3999], [10990, "ps5", "EP6853-PPSA25642_00-DELUXE0000000000", "edition", 4999], [11355, "xbox", "9NSWRGZBQ2MC", "base", 3999]];
    for (const [id, pl, sku, role, m] of maps) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,?,?,?,'paid',?,?,?)`).run(id, pl, sku, role, m, now, now);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,'2026-10-08','2026-10-08',?,?)`).run(id, N, N, now, now);
    }
    // PS5 native LTD series mirrors production: 16,042 on D1 (the anchor's frozen
    // baseline), 30,789 on Oct 9. Xbox has no estimate yet.
    for (const [d, u] of [["2026-10-07", 0], ["2026-10-08", 16042], ["2026-10-09", 30789]] as Array<[string, number]>)
      db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,method,created_at) VALUES(11296,'ps5','ltd',?,?,'ltd-anchor-median-v03',?)`).run(d, u, now);
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json() as Promise<any>;
    const b = await get("/api/console/titles/10664/revenue-daily?from=2026-10-06&to=2026-10-10");
    const at = (d: string) => b.points.find((p: any) => p.date === d);
    assert.equal(at("2026-10-06").steam, null); assert.equal(at("2026-10-07").steam, null);
    assert.equal(at("2026-10-08").steam, 4000 + 8000 + 28000);
    assert.equal(at("2026-10-08").d1, true);
    assert.equal(at("2026-10-09").steam, 12000); assert.equal(at("2026-10-10").steam, null);
    assert.equal(at("2026-10-07").ps5, null);
    // D1 is the operator actual (49,200 units) priced at the reported 55/45 mix
    // (45.49 blended); D2 is the native chart delta (14,747) at the base price.
    const asp = at("2026-10-09").ps5 / (14747 * 39.99); assert.ok(asp > 0);
    assert.ok(Math.abs(at("2026-10-08").ps5 - 49200 * 45.49 * asp) < 1e-6);
    assert.ok(Math.abs(at("2026-10-09").ps5 - 14747 * 39.99 * asp) < 1e-6);
    assert.equal(at("2026-10-08").basis.ps5, "operator_actual_anchor");
    assert.equal(at("2026-10-09").basis.ps5, "chart_estimate_steam_shaped");
    assert.equal(b.version, "hellraiser_steam_actuals_v2");
    assert.equal(b.dayOneActuals.length, 1);
    assert.equal(b.dayOneActuals[0].units, 49200);
    assert.equal(at("2026-10-08").xbox, null);
    // any sibling id gives the same series
    const x = await get("/api/console/titles/11296/revenue-daily?from=2026-10-08&to=2026-10-09");
    assert.equal(x.points[0].steam, 40000);
    // Fallback: with no window_estimates_daily rows at all, D1 still serves the
    // operator actual (missing evidence is not zero sales); later days blank.
    db.prepare("DELETE FROM window_estimates_daily WHERE title_id=11296").run();
    const f = await get("/api/console/titles/10664/revenue-daily?from=2026-10-08&to=2026-10-10");
    const fat = (d: string) => f.points.find((p: any) => p.date === d);
    assert.ok(fat("2026-10-08").ps5 != null && fat("2026-10-08").ps5 > 0);
    assert.equal(fat("2026-10-08").basis.ps5, "operator_actual_anchor");
    assert.equal(fat("2026-10-09").ps5, null);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
