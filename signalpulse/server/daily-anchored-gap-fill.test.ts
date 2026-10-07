import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// FC 27 Xbox (2026-10-07): a verified LTD anchor made the group "protected", which switched off gap allocation and the
// late-joiner rule, so the Xbox daily series showed nulls for 7 days, then a one-day $7.7M catch-up spike. A revenue
// anchor alone must not switch them off; an override, milestone or Saber product still must.
const DAYS = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];

async function seed(db: any, base: number, stamp: string) {
  const [a, b] = [base, base + 1];
  for (const id of [a, b]) {
    db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
      VALUES(?,'ps5',?,'base','paid',6000,?,?)`).run(id, `agf-${id}`, stamp, stamp);
    db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
      VALUES(?,?,?,'2026-09-24','2026-09-24',?,?)`).run(id, `Anchored Gap Fill ${base}`, `Anchored Gap Fill ${base}`, stamp, stamp);
  }
  DAYS.forEach((day, i) => db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
    VALUES(?,'ps5',?,'qa',?,'ltd',?)`).run(a, day, 82 + i * 100, stamp));
  DAYS.slice(1).forEach((day, i) => db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
    VALUES(?,'ps5','ltd',?,?,?,'rating:ltd_state:accumulator',?)`).run(a, day, 21560 + i * 10000, 132 + i * 100, stamp));
  for (const day of DAYS.slice(5, 10)) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
    VALUES(?,'ps5','ltd',?,NULL,8,'rating:ltd_state:accumulator',?)`).run(b, day, stamp);
  for (const [day, units] of [["2026-10-04", 5000], ["2026-10-05", 5300]] as const) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
    VALUES(?,'ps5','ltd',?,?,16,'rating:ltd_state:accumulator',?)`).run(b, day, units, stamp);
}
const anchor = (db: any, id: number, stamp: string, src = "manual_anchor_verified_ltd") => db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
  VALUES(?,'ps5','ltd',?,5000000,100000,6000,'regular',?,?)`).run(id, stamp, src, stamp);

test("a revenue anchor alone keeps late-joiner and gap-fill rules; other protections do not", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "anch-gap-"));
  process.chdir(dir);
  let server: any, db: any;
  const originalFetch = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const { dailyAllocationBlockReason } = await import("./daily-gap-allocation");
    const stamp = new Date().toISOString();
    await seed(db, 49901, stamp); await seed(db, 49911, stamp); await seed(db, 49921, stamp); await seed(db, 49931, stamp);
    anchor(db, 49911, stamp);                      // anchor only
    anchor(db, 49921, stamp);                      // anchor + manual multiplier override
    db.prepare(`INSERT INTO title_multiplier_overrides(title_id,platform,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at) VALUES(49921,'ps5',50,.5,.9,'low','fixture',?,?)`).run(stamp, stamp);
    anchor(db, 49931, stamp, "steam_sales_daily");  // anchor from an actual-sales feed
    assert.equal(dailyAllocationBlockReason(db, [49901, 49902]), null);
    assert.equal(dailyAllocationBlockReason(db, [49931, 49932]), "revenue_anchor", "actual-sales anchor still blocks");
    assert.equal(dailyAllocationBlockReason(db, [49911, 49912]), null, "anchor alone does not block");
    assert.equal(dailyAllocationBlockReason(db, [49921, 49922]), "multiplier_override");

    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const get = async (id: number, to: string) => {
      const r = await originalFetch(`http://127.0.0.1:${server.address().port}/api/console/titles/${id}/revenue-daily?from=2026-09-23&to=${to}`);
      assert.equal(r.status, 200); return await r.json() as any;
    };
    const plain = await get(49901, "2026-10-05"), anchored = await get(49911, "2026-10-05"), overridden = await get(49921, "2026-10-05");
    // Same shape of data, one anchored: identical series, no nulls from the late listing, no catch-up spike.
    assert.deepEqual(anchored.points.map((p: any) => p.ps5), plain.points.map((p: any) => p.ps5));
    assert.deepEqual(anchored.points.filter((p: any) => p.date >= "2026-09-24" && p.ps5 == null).map((p: any) => p.date), [], "no gap days");
    assert.deepEqual(anchored.lateListings?.map((l: any) => l.firstValuedDate), ["2026-10-04"]);
    const actuals = await get(49931, "2026-10-05");
    assert.ok(actuals.points.some((p: any) => p.date >= "2026-09-29" && p.date <= "2026-10-03" && p.ps5 == null), "actual-sales anchor keeps legacy gaps");
    // Override: legacy path kept, the late listing's null days still null the sum.
    assert.ok(overridden.points.some((p: any) => p.date >= "2026-09-29" && p.date <= "2026-10-03" && p.ps5 == null), "override group keeps legacy gaps");
    // Existing values never change: every day that was valued under the legacy path is the same under the new rule.
    for (const p of overridden.points) if (p.ps5 != null) assert.equal(anchored.points.find((q: any) => q.date === p.date).ps5 != null, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
