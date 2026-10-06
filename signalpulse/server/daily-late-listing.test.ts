import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Regression for CONTROL Resonant Xbox (2026-10-05): the Deluxe listing had null estimate rows until 2026-10-04 and
// two valued days by 2026-10-05. Querying through 10-05 instead of 10-04 turned every Xbox day from 09-29 to 10-04
// into null (the listing became "productive", the platform became multi-listing, allocation went off and its null
// days nulled the sum). Daily history must not depend on the query end date.
test("a listing that joins late cannot change earlier days or null the platform series", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "late-listing-"));
  process.chdir(dir);
  let server: any, db: any;
  const originalFetch = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    for (const id of [49891, 49892]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'ps5',?,'base','paid',6000,?,?)`).run(id, `late-${id}`, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,'Late Listing Regression','Late Listing Regression','2026-09-24','2026-09-24',?,?)`).run(id, stamp, stamp);
    }
    const days = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
    days.forEach((day, i) => db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
      VALUES(49891,'ps5',?,'qa',?,'ltd',?)`).run(day, 82 + i * 100, stamp));
    // base listing: valued every day from 09-25 (launch day 09-24 is allocated), +10,000 units per day
    days.slice(1).forEach((day, i) => db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
      VALUES(49891,'ps5','ltd',?,?,?,'rating:ltd_state:accumulator',?)`).run(day, 21560 + i * 10000, 132 + i * 100, stamp));
    // Deluxe listing: null estimate rows 09-29..10-03, first valued 10-04, +300 units on 10-05
    for (const day of days.slice(5, 10)) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
      VALUES(49892,'ps5','ltd',?,NULL,8,'rating:ltd_state:accumulator',?)`).run(day, stamp);
    for (const [day, units] of [["2026-10-04", 5000], ["2026-10-05", 5300]] as const) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
      VALUES(49892,'ps5','ltd',?,?,16,'rating:ltd_state:accumulator',?)`).run(day, units, stamp);

    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const get = async (to: string) => {
      const r = await originalFetch(`http://127.0.0.1:${server.address().port}/api/console/titles/49891/revenue-daily?from=2026-09-23&to=${to}`);
      assert.equal(r.status, 200); return await r.json() as any;
    };
    const at = (d: any, day: string) => d.points.find((p: any) => p.date === day);
    const thru1004 = await get("2026-10-04"), thru1005 = await get("2026-10-05"), thru1006 = await get("2026-10-06");
    assert.ok(at(thru1004, "2026-09-24").ps5 > 0, "fixture must carry the launch allocation");
    for (const day of days.slice(0, 11)) {
      assert.ok(at(thru1005, day).ps5 != null, `${day} must stay valued when the end date moves to 10-05`);
      assert.deepEqual(at(thru1005, day), at(thru1004, day), `end-date invariance: ${day}`);
    }
    // 10-05: base +10,000 units and Deluxe +300 units, each at 6000 cents x 0.8
    assert.equal(at(thru1005, "2026-10-05").ps5, 480000 + 14400);
    assert.deepEqual(thru1005.lateListings, [{ platform: "ps5", titleId: 49892, firstValuedDate: "2026-10-04", unitsAtFirstValuedDate: 5000 }]);
    assert.equal(thru1004.lateListings, undefined, "with one valued day the listing is not part of the series at all");
    for (const day of days.slice(0, 11)) assert.deepEqual(at(thru1006, day), at(thru1004, day), `invariance with an end date past the data: ${day}`);

    // A listing that is valued from the start of the main listing's history is a genuine second listing: the old rule holds
    // (allocation off, gap days stay gaps, the sum is null where either listing is missing).
    db.prepare("DELETE FROM window_estimates_daily WHERE title_id=49892").run();
    for (const [day, units] of [["2026-09-25", 3000], ["2026-09-26", 3500], ["2026-09-27", 4000], ["2026-09-28", 4500]] as const)
      db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
        VALUES(49892,'ps5','ltd',?,?,16,'rating:ltd_state:accumulator',?)`).run(day, units, stamp);
    const contemporaneous = await get("2026-09-28");
    assert.equal(contemporaneous.lateListings, undefined);
    assert.equal(at(contemporaneous, "2026-09-26").ps5, 480000 + 24000);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
