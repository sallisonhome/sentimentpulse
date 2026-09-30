import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("null siblings cannot erase revenue; later conflicting siblings cannot erase prior allocations", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "gap-cutoff-"));
  process.chdir(dir);
  let server: any, db: any;
  const originalFetch = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    for (const id of [49881, 49882]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'ps5',?,'base','paid',6000,?,?)`).run(id, `cutoff-${id}`, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,'Cutoff Regression','Cutoff Regression','2026-09-24','2026-09-24',?,?)`).run(id, stamp, stamp);
    }
    for (const [day, count] of [["2026-09-24", 82], ["2026-09-25", 132], ["2026-09-26", 232], ["2026-09-27", 332], ["2026-09-28", 432], ["2026-09-29", 532], ["2026-09-30", 632], ["2026-10-01", 732]] as const) {
      db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
        VALUES(49881,'ps5',?,'qa',?,'ltd',?)`).run(day, count, stamp);
    }
    for (const [id, day, units, signal] of [
      [49881, "2026-09-25", 21560, 132],
      [49881, "2026-09-26", 31560, 232],
      [49881, "2026-09-27", 41560, 332],
      [49881, "2026-09-28", 51560, 432],
      [49881, "2026-09-29", 61560, 532],
      [49882, "2026-09-29", null, 8],
      [49881, "2026-10-01", 81560, 732],
    ] as const) {
      db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
        VALUES(?,'ps5','ltd',?,?,?,'rating:ltd_state:accumulator',?)`).run(id, day, units, signal, stamp);
    }
    const app = express();
    registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (from: string, to: string) => {
      const r = await originalFetch(`http://127.0.0.1:${server.address().port}/api/console/titles/49881/revenue-daily?from=${from}&to=${to}`);
      assert.equal(r.status, 200);
      return await r.json() as any;
    };
    const narrow = await get("2026-09-23", "2026-09-28");
    const wide = await get("2026-09-23", "2026-10-01");
    const shifted = await get("2026-09-24", "2026-10-01");
    const at = (data: any, day: string) => data.points.find((p: any) => p.date === day);
    assert.ok(at(narrow, "2026-09-24").ps5 > 0, "fixture must have launch allocation");
    assert.deepEqual(at(narrow, "2026-09-24").allocation, { ps5: "launch:own_ratings" });
    for (const day of ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]) {
      assert.deepEqual(at(wide, day), at(narrow, day), `end-date invariance: ${day}`);
      assert.deepEqual(at(shifted, day), at(narrow, day), `start-date invariance: ${day}`);
    }
    assert.ok(Math.abs(at(wide, "2026-09-24").ps5 + at(wide, "2026-09-25").ps5 - 21560 * 48) < 1e-6);
    assert.equal(at(wide, "2026-09-29").ps5, 480000, "null sibling must not overwrite a valued day");
    assert.equal(at(wide, "2026-09-30").ps5, 480000);
    assert.equal(at(wide, "2026-10-01").ps5, 480000);
    // A genuinely conflicting observation disables allocation from its date,
    // but must not erase the unambiguous historical prefix.
    db.prepare("UPDATE window_estimates_daily SET units_mid=71560,signal_value=532 WHERE title_id=49882").run();
    const conflict = await get("2026-09-23", "2026-10-01");
    for (const day of ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]) {
      assert.deepEqual(at(conflict, day), at(narrow, day), `conflicting future row: ${day}`);
    }
    assert.equal(at(conflict, "2026-09-30").ps5, null);
    assert.equal(at(conflict, "2026-10-01").ps5, null);
    // Anchored titles retain strict, unallocated output.
    db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
      VALUES(49881,'ps5','ltd','2026-09-28',2474880,51560,6000,'full','qa',?)`).run(stamp);
    const protectedResponse = await get("2026-09-23", "2026-10-01");
    assert.equal(at(protectedResponse, "2026-09-24").ps5, null);
    assert.equal(at(protectedResponse, "2026-09-25").ps5, null);
    assert.equal(at(protectedResponse, "2026-09-26").ps5, 480000);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
