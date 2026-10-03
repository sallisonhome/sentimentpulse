import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Chart-only: distinct store listings of one platform (Standard and Deluxe) are summed, each at
// its own price, as the board does. An unpriced twin is a duplicate and is dropped.
test("Standard + Deluxe listings sum on the chart; an unpriced duplicate listing is ignored", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "chart-multi-"));
  process.chdir(dir);
  let server: any, db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    const add = (id: number, platform: string, name: string, cents: number | null, base: number) => {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',?,?,?)`).run(id, platform, `multi-${id}`, cents, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2026-01-01','2026-01-01',?,?)`).run(id, name, name, stamp, stamp);
      [0, 1, 2, 3].forEach(i => db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,method,created_at)
        VALUES(?,?,'ltd',?,?,'rating:ltd_state:accumulator',?)`).run(id, platform, `2026-09-2${i}`, base + i * 100, stamp));
    };
    add(70001, "ps5", "Multi Listing Game", 5000, 10000);
    add(70002, "ps5", "Multi Listing Game: Deluxe Edition", 8000, 2000);
    add(70003, "ps5", "Multi Listing Game", null, 10000);   // unpriced duplicate, must not count
    add(70004, "steam", "Multi Listing Game", 6000, 50000);
    const app = express();
    registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.once("listening", r));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/console/titles/70004/revenue-daily?from=2026-09-20&to=2026-09-23`);
    const body = await r.json() as any;
    const day = body.points.find((p: any) => p.date === "2026-09-22");
    const solo = await (await fetch(`http://127.0.0.1:${server.address().port}/api/console/titles/70001/revenue-daily?from=2026-09-20&to=2026-09-23`)).json() as any;
    assert.ok(day.ps5 > 0, "ps5 line present");
    assert.ok(day.xbox == null);
    // 100 units/day on each priced listing: 100*5000 + 100*8000 (cents) times the PS5 factor.
    const factor = day.ps5 / ((100 * 5000 + 100 * 8000) / 100);
    assert.ok(factor > 0.5 && factor <= 1, `factor ${factor}`);
    assert.ok(Math.abs(day.ps5 - solo.points.find((p: any) => p.date === "2026-09-22").ps5) < 1e-6, "same chart from any sibling id");
  } finally {
    if (server) await new Promise<void>((res, rej) => server.close((e: any) => e ? rej(e) : res()));
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
